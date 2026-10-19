// Google Apps Script that emails Juan Pablo a meeting request from the website chat.
// Must match the MEETING_SECRET stored in the Cloudflare Worker.
const SECRET = 'CHANGE-ME';

// Run once from the editor to grant the permission to send email.
function authorize() {
  Logger.log('Emails left today: ' + MailApp.getRemainingDailyQuota());
}

function doPost(e) {
  let data;
  try {
    data = JSON.parse(e.postData.contents);
  } catch (err) {
    return ContentService.createTextOutput('bad-request');
  }
  if (data.secret !== SECRET) return ContentService.createTextOutput('forbidden');

  const subject = `Website chat: ${data.name} wants to meet`;
  const body = [
    `Name: ${data.name}`,
    `Email: ${data.email}`,
    `Topic: ${data.topic}`,
    `Preferred time: ${data.preferredTime || 'not specified'}`,
    `Chat language: ${data.lang}`,
    '',
    'Conversation summary:',
    data.summary,
    '',
    'Reply to this email to answer the visitor directly.',
  ].join('\n');

  MailApp.sendEmail({
    to: Session.getEffectiveUser().getEmail(),
    replyTo: data.email,
    subject: subject,
    body: body,
    name: 'Virtual JP',
  });

  return ContentService.createTextOutput('ok');
}
