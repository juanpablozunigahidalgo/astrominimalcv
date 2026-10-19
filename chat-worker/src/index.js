import persona from './persona.txt';

const MAX_MESSAGE_LENGTH = 500;
const MAX_HISTORY = 12;
const CV_CACHE_SECONDS = 3600;
const GEMINI_TIMEOUT_MS = 20000;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const MEETING_TOOL = {
  function_declarations: [
    {
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
    },
  ],
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
    const canBook = Boolean(env.MEETING_WEBHOOK_URL && env.MEETING_SECRET);

    const cv = await getCv(env, ctx);
    const systemPrompt = [
      persona,
      `PAGE LANGUAGE: ${lang}`,
      `MEETING REQUESTS: ${canBook ? 'available through the request_meeting tool' : 'not available, share the email and LinkedIn instead'}`,
      `MY CV:\n${cv}`,
    ].join('\n\n');

    const contents = [
      ...history.map((h) => ({ role: h.role, parts: [{ text: h.text }] })),
      { role: 'user', parts: [{ text: message }] },
    ];

    let result = await gemini(env, systemPrompt, contents, canBook);
    if (result.error) return json({ error: result.error }, result.status, cors);

    let meetingSent = false;
    const call = result.content.parts?.find((p) => p.functionCall)?.functionCall;
    if (call?.name === 'request_meeting' && canBook) {
      const outcome = await sendMeetingRequest(env, call.args || {}, lang);
      meetingSent = outcome.ok;
      contents.push(result.content, {
        role: 'user',
        parts: [{ functionResponse: { name: call.name, response: outcome } }],
      });
      result = await gemini(env, systemPrompt, contents, false);
      if (result.error) return json({ error: result.error }, result.status, cors);
    }

    const reply = (result.content.parts || [])
      .map((p) => p.text || '')
      .join('')
      .trim();
    if (!reply) return json({ error: 'empty-reply' }, 502, cors);

    return json({ reply, meetingSent }, 200, cors);
  },
};

async function gemini(env, systemPrompt, contents, withTools) {
  const body = JSON.stringify({
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents,
    ...(withTools ? { tools: [MEETING_TOOL] } : {}),
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

async function getCv(env, ctx) {
  const cache = caches.default;
  const key = new Request(env.CV_URL);
  let res = await cache.match(key);
  if (!res) {
    const upstream = await fetch(env.CV_URL);
    if (!upstream.ok) return '(CV temporarily unavailable)';
    res = new Response(await upstream.text(), {
      headers: { 'Cache-Control': `max-age=${CV_CACHE_SECONDS}` },
    });
    ctx.waitUntil(cache.put(key, res.clone()));
  }
  return compactCv(await res.text());
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
