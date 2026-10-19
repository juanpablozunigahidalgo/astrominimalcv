import persona from './persona.txt';

const MAX_MESSAGE_LENGTH = 500;
const MAX_HISTORY = 12;
const MAX_TURNS = 30;
const OFFER_CONTACT_EVERY = 4;
const SOURCE_CACHE_SECONDS = 3600;
const GEMINI_TIMEOUT_MS = 20000;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const MEETING_DECLARATION = {
  name: 'request_meeting',
  description:
    'Send the real Juan Pablo a meeting request by email. Only call it when the visitor has already given their name, a valid email and the topic, you have read those details back to them, and their latest message explicitly confirms (for example "yes, send it").',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Visitor full name' },
      email: { type: 'string', description: 'Visitor email address' },
      topic: { type: 'string', description: 'What the visitor wants to talk about' },
      preferred_time: { type: 'string', description: 'Days or times the visitor suggested, if any' },
      summary: {
        type: 'string',
        description: 'Short summary of the whole conversation, written in English for Juan Pablo',
      },
    },
    required: ['name', 'email', 'topic', 'summary'],
  },
};

const END_DECLARATION = {
  name: 'end_conversation',
  description:
    'Close the chat for good. Use it when the visitor insults or harasses Juan Pablo or you, uses hateful or sexual language, or keeps misusing the chat after one calm warning.',
  parameters: {
    type: 'object',
    properties: { reason: { type: 'string', description: 'Short reason, in English' } },
    required: ['reason'],
  },
};

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';
    const allowed = env.ALLOWED_ORIGINS.split(',').map((o) => o.trim());
    const cors = {
      'Access-Control-Allow-Origin': allowed.includes(origin) ? origin : allowed[0],
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      Vary: 'Origin',
    };

    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (request.method !== 'POST') return json({ error: 'method' }, 405, cors);
    if (!allowed.includes(origin)) return json({ error: 'origin' }, 403, cors);

    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const { success } = await env.CHAT_LIMITER.limit({ key: ip });
    if (!success) return json({ error: 'limit' }, 429, cors);

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'body' }, 400, cors);
    }

    const message = String(body.message || '').trim().slice(0, MAX_MESSAGE_LENGTH);
    if (!message) return json({ error: 'empty' }, 400, cors);
    const lang = String(body.lang || 'english').slice(0, 20);
    const history = sanitizeHistory(body.history);
    const turn = Math.floor(Number(body.turn) || 0) + 1;
    if (turn > MAX_TURNS) return json({ error: 'max-turns' }, 429, cors);
    const canBook = Boolean(env.MEETING_WEBHOOK_URL && env.MEETING_SECRET);

    const [cv, knowledge] = await Promise.all([
      getSource(env.CV_URL, ctx).then((text) => (text ? compactCv(text) : '(CV temporarily unavailable)')),
      env.KNOWLEDGE_URL ? getSource(env.KNOWLEDGE_URL, ctx) : Promise.resolve(''),
    ]);
    const systemPrompt = [
      persona,
      `PAGE LANGUAGE: ${lang}`,
      `MEETING REQUESTS: ${canBook ? 'available through the request_meeting tool' : 'not available, share the email and LinkedIn instead'}`,
      turn % OFFER_CONTACT_EVERY === 0
        ? 'THIS REPLY: after answering, ask in one short sentence if they need anything else or would like to connect with the real Juan Pablo directly.'
        : '',
      `MY KNOWLEDGE (how I think, my views and my answers):\n${knowledge || '(nothing shared yet)'}`,
      `MY CV:\n${cv}`,
    ]
      .filter(Boolean)
      .join('\n\n');

    const contents = [
      ...history.map((h) => ({ role: h.role, parts: [{ text: h.text }] })),
      { role: 'user', parts: [{ text: message }] },
    ];

    const tools = canBook ? [MEETING_DECLARATION, END_DECLARATION] : [END_DECLARATION];
    let result = await gemini(env, systemPrompt, contents, tools);
    if (result.error) return json({ error: result.error }, result.status, cors);

    let meetingSent = false;
    let bookingUrl = '';
    let ended = false;
    const call = result.content.parts?.find((p) => p.functionCall)?.functionCall;
    if (call) {
      let outcome = { ok: false, reason: 'Unknown tool.' };
      if (call.name === 'request_meeting' && canBook) {
        outcome = await sendMeetingRequest(env, call.args || {}, lang);
        meetingSent = outcome.ok;
        if (meetingSent && env.CALENDLY_URL) {
          bookingUrl = calendlyLink(env.CALENDLY_URL, call.args || {});
          outcome.calendar =
            'The website shows a calendar link right below your reply, already filled in with the visitor details. Tell the visitor to pick a time with the link below. Do not write any URL in this reply.';
        }
      } else if (call.name === 'end_conversation') {
        ended = true;
        console.log('Conversation ended:', call.args?.reason);
        outcome = { ok: true, instruction: 'Say a short, calm goodbye in the visitor\'s language, without lecturing.' };
      }
      contents.push(result.content, {
        role: 'user',
        parts: [{ functionResponse: { name: call.name, response: outcome } }],
      });
      result = await gemini(env, systemPrompt, contents, null);
      if (result.error) return json({ error: result.error }, result.status, cors);
    }

    const reply = (result.content.parts || [])
      .map((p) => p.text || '')
      .join('')
      .trim();
    if (!reply) return json({ error: 'empty-reply' }, 502, cors);

    return json({ reply, meetingSent, bookingUrl, ended }, 200, cors);
  },
};

function calendlyLink(base, args) {
  const url = new URL(base);
  if (args.name) url.searchParams.set('name', String(args.name).slice(0, 200));
  if (args.email) url.searchParams.set('email', String(args.email).slice(0, 200));
  if (args.topic) url.searchParams.set('a1', String(args.topic).slice(0, 500));
  return url.toString();
}

async function gemini(env, systemPrompt, contents, declarations) {
  const body = JSON.stringify({
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents,
    ...(declarations ? { tools: [{ function_declarations: declarations }] } : {}),
    generationConfig: { temperature: 0.7, maxOutputTokens: 1024 },
  });
  const models = env.GEMINI_MODELS.split(',').map((m) => m.trim()).filter(Boolean);
  let failure = { error: 'upstream', status: 502 };

  for (const model of models) {
    let res;
    try {
      res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
          body,
          signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS),
        }
      );
    } catch (err) {
      console.error('Gemini timeout or network error', model, err);
      failure = { error: 'upstream', status: 502 };
      continue;
    }

    if (res.ok) {
      const data = await res.json();
      const content = data.candidates?.[0]?.content;
      if (content) return { content };
      failure = { error: 'empty-reply', status: 502 };
      continue;
    }

    console.error('Gemini error', model, res.status, await res.text());
    failure = res.status === 429 ? { error: 'limit', status: 429 } : { error: 'upstream', status: 502 };
    if (res.status !== 429 && res.status < 500) break;
  }
  return failure;
}

async function sendMeetingRequest(env, args, lang) {
  const email = String(args.email || '').trim();
  if (!EMAIL_PATTERN.test(email)) return { ok: false, reason: 'The email address looks invalid, ask the visitor again.' };

  const payload = {
    secret: env.MEETING_SECRET,
    name: String(args.name || '').slice(0, 200),
    email: email.slice(0, 200),
    topic: String(args.topic || '').slice(0, 500),
    preferredTime: String(args.preferred_time || '').slice(0, 200),
    summary: String(args.summary || '').slice(0, 3000),
    lang,
  };

  try {
    // Apps Script answers the POST with a redirect whose result must be fetched with GET.
    let res = await fetch(env.MEETING_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      redirect: 'manual',
    });
    const location = res.headers.get('Location');
    if (res.status >= 300 && res.status < 400 && location) res = await fetch(location);
    const text = (await res.text()).trim();
    if (text === 'ok') return { ok: true };
    console.error('Meeting webhook error', res.status, text.slice(0, 200));
  } catch (err) {
    console.error('Meeting webhook error', err);
  }
  return {
    ok: false,
    reason:
      'NOT SENT. Tell the visitor the request could not be sent and invite them to write to juanpablo.zunigah@gmail.com instead.',
  };
}

function json(payload, status, headers) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json' },
  });
}

function sanitizeHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter((h) => h && (h.role === 'user' || h.role === 'model') && typeof h.text === 'string')
    .slice(-MAX_HISTORY)
    .map((h) => ({ role: h.role, text: h.text.slice(0, 2000) }));
}

async function getSource(url, ctx) {
  const cache = caches.default;
  const key = new Request(url);
  let res = await cache.match(key);
  if (!res) {
    const upstream = await fetch(url);
    if (!upstream.ok) return '';
    res = new Response(await upstream.text(), {
      headers: { 'Cache-Control': `max-age=${SOURCE_CACHE_SECONDS}` },
    });
    ctx.waitUntil(cache.put(key, res.clone()));
  }
  return res.text();
}

function compactCv(markdown) {
  const raw = markdown.replace(/^---\s*/, '').replace(/\s*---\s*$/, '');
  let cv;
  try {
    cv = JSON.parse(raw.replace(/\r?\n(?=\s*[^\s"{}\[\],])/g, ' '));
  } catch {
    return raw;
  }
  const date = (d) => (d ? `${d.monthName} ${d.year}` : '');
  const lines = [
    `Name: ${cv.name}`,
    `Summary: ${cv.summary}`,
    `Skills: ${(cv.skills || []).join(', ')}`,
    'Experience:',
    ...(cv.professionalExperience || []).map(
      (e) => `- ${e.title} at ${e.company}, ${e.location} (${date(e.startDate)} to ${date(e.endDate)}): ${e.description}`
    ),
    'Education:',
    ...(cv.formalEducation || []).map(
      (e) => `- ${e.degree}, ${e.university} (${e.startDate?.year} to ${e.endDate?.year})`
    ),
    'Courses and certifications:',
    ...(cv.coursesAndCertifications || []).map((c) => `- ${c.course}, ${c.provider} (${c.endDate?.year})`),
    `Languages: ${(cv.personalInformation?.languages || []).join(', ')}`,
    `Nationality: ${(cv.personalInformation?.nationality || []).join(', ')}`,
  ];
  return lines.join('\n');
}
