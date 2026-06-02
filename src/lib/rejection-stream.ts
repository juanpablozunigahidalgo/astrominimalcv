const COMPANIES = [
  'Meridian Advisory Group',
  'Northbridge Capital Partners',
  'Helix Compliance GmbH',
  'Sterling & Vale Associates',
  'Cobalt Ridge Technologies',
  'Aster Lane Holdings',
  'Pinnacle Row Partners',
  'Summit Gate Analytics',
  'Verdant Oak Corporate Services',
  'Ironwood Strategic LLC',
  'Lumen Field Consulting',
  'Harborline Mutual',
  'Cedar & Finch Advisory',
  'Orbit Vale Industries',
  'Glassford Equity Partners',
];

const ROLES = [
  'Senior Product Manager',
  'Associate Legal Counsel',
  'Director of Corporate Strategy',
  'VP of Business Development',
  'Head of People Operations',
  'Financial Planning Analyst',
  'Senior Data Scientist',
  'Corporate Communications Manager',
  'Supply Chain Program Lead',
  'Tax Policy Specialist',
  'Customer Success Director',
  'Mergers & Acquisitions Associate',
  'Regional Marketing Manager',
  'Chief of Staff',
  'Sustainability Reporting Analyst',
];

const OPENINGS = [
  'Thank you for taking the time to apply for the {role} position at {company}.',
  'We appreciate your interest in the {role} role with {company} and the effort you put into your application.',
  'After careful consideration of your application for {role} at {company}, we have reached a decision.',
];

const MIDDLES = [
  'We received many strong applications, and although your background is impressive, we have decided to move forward with candidates whose experience more closely matches our current needs.',
  'At this stage, we are unable to offer you a place in our process. This reflects the competitiveness of the search rather than a judgment on your overall qualifications.',
  'Our hiring committee concluded that another profile aligns more closely with the scope of the team for the coming quarter.',
  'We will not be progressing your candidacy further for this opening. We encourage you to review future postings that may be a closer fit.',
];

const CLOSINGS = [
  'We wish you the very best in your search and thank you again for your interest in {company}.',
  'Please feel free to apply for other roles that match your experience. We appreciate your interest in {company}.',
  'We hope you will consider {company} again and we wish you success in your career.',
];

function pick<T>(items: T[]): T {
  return items[Math.floor(Math.random() * items.length)]!;
}

function fill(template: string, company: string, role: string): string {
  return template.replaceAll('{company}', company).replaceAll('{role}', role);
}

export function generateLocalRejection(): { company: string; role: string; body: string } {
  const company = pick(COMPANIES);
  const role = pick(ROLES);
  const paragraphs = [
    'Dear Applicant,',
    '',
    fill(pick(OPENINGS), company, role),
    fill(pick(MIDDLES), company, role),
    fill(pick(CLOSINGS), company, role),
    '',
    'Sincerely,',
    'Talent Acquisition',
    company,
  ];
  return { company, role, body: paragraphs.join('\n') };
}

function buildAiPrompt(company: string, role: string): string {
  return [
    'Write a professional job rejection email in English.',
    `Fictional employer: ${company}.`,
    `Fictional white-collar role: ${role}.`,
    '120 to 180 words. Formal but humane tone.',
    'Include greeting and sign-off from Human Resources.',
    'Do not mention that the company is fictional.',
    'Output only the email text.',
  ].join(' ');
}

async function fetchPollinations(prompt: string): Promise<string> {
  const url = `https://text.pollinations.ai/${encodeURIComponent(prompt)}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Pollinations ${response.status}`);
  const text = (await response.text()).trim();
  if (text.length < 80) throw new Error('Response too short');
  return text;
}

export async function generateRejection(): Promise<{
  company: string;
  role: string;
  body: string;
  source: 'ai' | 'local';
}> {
  const company = pick(COMPANIES);
  const role = pick(ROLES);
  const prompt = buildAiPrompt(company, role);

  try {
    const body = await fetchPollinations(prompt);
    return { company, role, body, source: 'ai' };
  } catch {
    const local = generateLocalRejection();
    return { ...local, source: 'local' };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function appendLetter(
  feed: HTMLElement,
  letter: { company: string; role: string; body: string }
): void {
  const article = document.createElement('article');
  article.className = 'rejection-letter';

  const meta = document.createElement('p');
  meta.className = 'rejection-meta';
  meta.textContent = `${letter.company} — ${letter.role}`;

  const body = document.createElement('pre');
  body.className = 'rejection-body';
  body.textContent = letter.body;

  article.append(meta, body);
  feed.appendChild(article);
}

export function startRejectionStream(
  feed: HTMLElement | null,
  status: HTMLElement | null
): void {
  if (!feed) return;

  let busy = false;

  const tick = async () => {
    if (busy) return;
    busy = true;
    if (status) status.textContent = 'Writing…';

    try {
      const letter = await generateRejection();
      appendLetter(feed, letter);
      if (status) {
        status.textContent =
          letter.source === 'ai'
            ? 'Fictional rejections · English · AI'
            : 'Fictional rejections · English';
      }
    } finally {
      busy = false;
    }
  };

  void tick();
  window.setInterval(() => void tick(), 14000);
}
