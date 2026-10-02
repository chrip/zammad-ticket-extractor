// node --test "test/*.test.cjs"
const { test } = require('node:test');
const assert = require('node:assert/strict');
// src/ is plain browser script (the package is "type": "module"), so evaluate it as one.
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const createPseudonymizer = new Function(readFileSync(join(__dirname, '../src/pseudonymize.js'), 'utf8') + '\nreturn createPseudonymizer;')();

// A fictional support company "Supportco" (supportco.io) with a product "WidgetOffice".
function setup() {
  const p = createPseudonymizer({ internalDomains: ['supportco.io'], publicHosts: ['help.supportco.io', 'github.com', 'forum.widgetoffice.org'] });
  p.addPerson({ firstname: 'John', lastname: 'Smith', email: 'j.smith@acme-corp.com', phones: ['+1 415 555 0134'], role: 'customer' });
  p.addPerson({ firstname: 'Anna', lastname: 'Young', email: 'anna.young@supportco.io', role: 'agent' });
  p.addOrganization('Acme Corp Inc.', ['acme-corp.com']);
  return p;
}

test('known people, their mail and phone get consistent pseudonyms', () => {
  const p = setup();
  const out = p.text('Hi Mr. Smith, thanks John! Mail j.smith@acme-corp.com or call +1 415 555 0134. Best, Anna Young');
  assert.equal(out, 'Hi Mr. Customer-1, thanks Customer-1! Mail customer-1@example.com or call [phone-1]. Best, Anna');
});

test('staff are shown by first name only', () => {
  const p = setup();
  p.addPerson({ name: 'Jonas Meurer', email: 'jonas.meurer@supportco.io', role: 'agent' });
  assert.equal(p.text('Anna Young and Jonas Meurer via Supportco, ask Ms. Young or Meurer, Young, Anna'),
    'Anna and Jonas via Supportco, ask Ms. Anna or Jonas, Anna');
});

test('mailbox accounts of staff keep their whole name', () => {
  const p = setup();
  p.addProtectedName('Supportco GmbH');
  p.addPerson({ firstname: 'Supportco', lastname: 'Support', email: 'support@supportco.io', role: 'agent' });
  p.addPerson({ firstname: 'Portal', lastname: 'Bot', email: 'bot@supportco.io', role: 'agent' });
  assert.equal(p.text('Supportco Support and Portal Bot'), 'Supportco Support and Portal Bot');
});

test('one person with two mail addresses keeps one pseudonym', () => {
  const p = createPseudonymizer();
  p.addPerson({ name: 'John Smith', email: 'j.smith@acme-corp.de', role: 'customer' });
  p.addPerson({ name: 'John Smith', email: 'j.smith@acme-corp.com', role: 'customer' });
  assert.equal(p.text('John Smith: j.smith@acme-corp.com, j.smith@acme-corp.de'), 'Customer-1: customer-1@example.com, customer-1@example.com');
});

test('numbers follow the order of appearance, not of registration', () => {
  const p = createPseudonymizer();
  for (const n of ['Ann Ames', 'Ben Bell', 'Cid Cole']) p.addPerson({ name: n, email: `${n.split(' ')[0].toLowerCase()}@acme-corp.com`, role: 'customer' });
  assert.equal(p.text('Cid Cole wrote to ben@acme-corp.com'), 'Customer-1 wrote to customer-2@example.com');
  assert.equal(p.text('Ann Ames and Cid'), 'Customer-3 and Customer-1');
});

test('URLs keep balanced parentheses, a wrapping one stays outside', () => {
  const p = setup();
  assert.equal(p.text('LTS ([internal] https://cloud.supportco.io/Support/Long%20term%20support%20(LTS)?fileId=7081382)'),
    'LTS ([internal] [internal-link-1])');
});

test('support agents stay readable by name, their mails are pseudonymized', () => {
  const p = setup();
  assert.equal(p.text('Hi Anna, thanks. Cc: anna.young@supportco.io, office-team@supportco.io'), 'Hi Anna, thanks. Cc: agent-1@example.com, user-1@example.com');
});

test('an agent the caller could not confirm as staff is pseudonymized', () => {
  const p = createPseudonymizer();
  p.addPerson({ name: 'Paul Grant', email: 'paul.grant@acme-corp.com', role: 'agent', keep: false });
  assert.equal(p.text('Hi Paul, Paul Grant wrote'), 'Hi Agent-1, Agent-1 wrote');
});

test('with keepAgents off, agents are pseudonymized too', () => {
  const p = createPseudonymizer({ keepAgents: false });
  p.addPerson({ firstname: 'Anna', lastname: 'Young', email: 'anna.young@supportco.io', role: 'agent' });
  assert.equal(p.text('Hi Anna, write to anna.young@supportco.io'), 'Hi Agent-1, write to agent-1@example.com');
});

test('the support company and configured product names are never taken for a person', () => {
  const p = createPseudonymizer({ keepAgents: false, protectedWords: ['WidgetOffice'] });
  p.addProtectedName('Supportco GmbH');
  p.addPerson({ name: 'Supportco Support', email: 'support@supportco.io', role: 'agent' });
  p.addPerson({ name: 'WidgetOffice Admin', email: 'admin@acme-corp.com', role: 'customer' });
  assert.equal(p.text('WidgetOffice in Supportco, Supportco support ticket received'), 'WidgetOffice in Supportco, Supportco support ticket received');
});

test('an internal domain learned from an agent protects its name', () => {
  const p = createPseudonymizer({ keepAgents: false });
  p.addInternalDomain('supportco.io');
  p.addPerson({ name: 'Supportco Team', email: 'team@supportco.io', role: 'agent' });
  assert.equal(p.text('Supportco ticket, see https://crm.supportco.io/deal/9'), 'Supportco ticket, see [internal-link-1]');
});

test('no company or product is built in', () => {
  const p = createPseudonymizer();
  p.addPerson({ name: 'Acme Support', email: 'support@acme-corp.com', role: 'customer' });
  assert.equal(p.text('Acme rocks, https://docs.acme-corp.com/x'), 'Customer-1 rocks, https://docs.domain1.example/x');
});

test('internal links are dropped, public ones kept', () => {
  const p = setup();
  const out = p.text('See https://cloud.supportco.io/apps/handbook?fileId=1 and https://portal.supportco.io/customer/42 and again https://cloud.supportco.io/apps/handbook?fileId=1. Docs: https://help.supportco.io/t/1 https://forum.widgetoffice.org/t/4177/10');
  assert.equal(out, 'See [internal-link-1] and [internal-link-2] and again [internal-link-1]. Docs: https://help.supportco.io/t/1 https://forum.widgetoffice.org/t/4177/10');
});

test('public and internal host lists are configurable', () => {
  const p = createPseudonymizer({ publicHosts: ['*.acme-corp.com'], internalDomains: ['support-corp.io'] });
  assert.equal(p.text('https://wiki.acme-corp.com/x https://crm.support-corp.io/deal/9 https://github.com/a/b'), 'https://wiki.acme-corp.com/x [internal-link-1] https://domain1.example/a/b');
});

test('names with umlauts also match their ASCII spellings', () => {
  const p = createPseudonymizer();
  p.addPerson({ firstname: 'Jürgen', lastname: 'Müller', role: 'customer' });
  assert.equal(p.text('Mr. Mueller and Mr. Muller and Jürgen'), 'Mr. Customer-1 and Mr. Customer-1 and Customer-1');
});

test('a surname that is also a word is only replaced capitalized', () => {
  const p = createPseudonymizer();
  p.addPerson({ firstname: 'Mary', lastname: 'Young', role: 'customer' });
  assert.equal(p.text('The setup is young. Ms. Young will check it.'), 'The setup is young. Ms. Customer-1 will check it.');
});

test('organization with and without legal form', () => {
  const p = setup();
  assert.equal(p.text('Acme Corp Inc. uses Acme Corp internally'), 'Org-1 uses Org-1 internally');
});

test('unknown names after a salutation, also where they come first', () => {
  const p = setup();
  assert.equal(p.text('Weber reported it.\nDear Mr. Weber,\nThanks, Tom'), 'Person-1 reported it.\nDear Mr. Person-1,\nThanks, Person-2');
  const generic = 'Hi all,\nHello team\nDear Valued Customer\nThank you for the logs\nThanks again\nGood morning';
  assert.equal(p.text(generic), generic);
});

test('German salutations still work', () => {
  const p = setup();
  assert.equal(p.text('Hallo Herr Weber, Liebe Grüße'), 'Hallo Herr Person-1, Liebe Grüße');
});

test('URLs: host, user path, share token and query values', () => {
  const p = setup();
  const out = p.text('See https://cloud.acme-corp.com/remote.php/dav/files/jsmith/Docs/a.txt?foo=bar and https://cloud.acme-corp.com/index.php/s/AbCdEfGh1234.');
  assert.equal(out, 'See https://cloud.domain1.example/remote.php/dav/files/user-1/Docs/a.txt?foo=[redacted] and https://cloud.domain1.example/index.php/s/SHARE1.');
});

test('text glued to the front of a URL stays text', () => {
  const p = setup();
  assert.equal(p.text('not only Firefox.https://help.supportco.io/t/246654'), 'not only Firefox.https://help.supportco.io/t/246654');
  assert.equal(p.text('see:https://crm.supportco.io/deal/1'), 'see:[internal-link-1]');
});

test('public domains are kept with their path', () => {
  const p = setup();
  const s = 'Docs: https://help.supportco.io/server/latest/admin_manual/ and https://github.com/supportco/server/issues/123';
  assert.equal(p.text(s), s);
});

test('bare hostnames, also inside file names', () => {
  const p = setup();
  assert.equal(p.text('Server x7.acme-corp.com and office.acme-corp.com'), 'Server host1.domain1.example and office.domain1.example');
  assert.equal(p.text('[image: screenshot-cloud.acme-corp.com.png]'), '[image: host2.domain1.example.png]');
});

test('file names and code are not hosts', () => {
  const p = setup();
  const s = 'see server.log, config.php, e.target.value, OC.Files.App and console.log';
  assert.equal(p.text(s), s);
});

test('IPs: public to documentation ranges, private stays private, loopback and versions kept', () => {
  const p = setup();
  assert.equal(p.text('from 85.214.1.2 and 85.214.1.2, lan 192.168.1.10, local 127.0.0.1'), 'from 192.0.2.1 and 192.0.2.1, lan 10.255.0.2, local 127.0.0.1');
  assert.equal(p.text('It is the proxy at 10.0.0.5.'), 'It is the proxy at 10.255.0.3.');
  assert.equal(p.text('"version":"29.0.4.1" release 28.0.1.2'), '"version":"29.0.4.1" release 28.0.1.2');
  const withProduct = createPseudonymizer({ protectedWords: ['WidgetOffice'] });
  assert.equal(withProduct.text('WidgetOffice 8.1.0.3 on 85.214.1.2'), 'WidgetOffice 8.1.0.3 on 192.0.2.1');
  assert.equal(p.text('remote 2a01:4f8:c0c:1234::1 and ::1'), 'remote 2001:db8::1 and ::1');
  assert.equal(p.text('at 12:34:56 in Foo::bar'), 'at 12:34:56 in Foo::bar');
});

test('secrets in config.php and JSON are redacted', () => {
  const p = setup();
  assert.equal(p.text("  'dbpassword' => 's3cr3t!',"), "  'dbpassword' => '[redacted]',");
  assert.equal(p.text('"secret":"abc123","instanceid":"oc1x2"'), '"secret":"[redacted]","instanceid":"[redacted]"');
  assert.equal(p.text('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.x'), 'Authorization: Bearer [redacted]');
});

test('passwords in free text, English and German', () => {
  const p = setup();
  assert.equal(p.text('Link: https://cloud.acme-corp.com/s/AbCdEfGh1234\nPasswort: 4rz5wQX8'), 'Link: https://cloud.domain1.example/s/SHARE1\nPasswort: [redacted]');
  assert.equal(p.text('Password for the share: "x7!Kp2q"'), 'Password for the share: "[redacted]"');
  assert.equal(p.text('The password is Hunter22. Thanks'), 'The password is [redacted]. Thanks');
  assert.equal(p.text('Das Kennwort lautet geheim123'), 'Das Kennwort lautet [redacted]');
  assert.equal(p.text('PIN: 4711'), 'PIN: [redacted]');
  assert.equal(p.text('Pin it to the top: done'), 'Pin it to the top: done');
});

test('staff confirmed by the API stay kept when the page repeats them', () => {
  const p = setup();
  p.addPerson({ firstname: 'Portal', lastname: 'Bot', email: 'bot@supportco.io', role: 'agent' });
  p.addPerson({ name: 'Portal Bot', email: 'bot@supportco.io', role: 'agent', keep: false });
  assert.equal(p.text('Portal Bot wrote'), 'Portal Bot wrote');
});

test('JSON-lines log: user IDs from fields are replaced on every line', () => {
  const p = setup();
  const log = [
    '{"reqId":"a1","level":3,"time":"2026-09-30T10:00:00+00:00","remoteAddr":"85.214.9.9","user":"--","app":"core","method":"PUT","url":"/remote.php/dav/files/bob/x.txt","message":"Sabre error","version":"29.0.4.1"}',
    '{"reqId":"a2","level":2,"remoteAddr":"85.214.9.9","user":"bob","app":"files","url":"/index.php/apps/files/","message":"File not found: /var/www/cloud/data/bob/files/report.pdf","version":"29.0.4.1"}'
  ].join('\n');
  const out = p.file(log);
  assert.ok(!out.includes('bob'), out);
  assert.ok(!out.includes('85.214.9.9'), out);
  assert.ok(out.includes('"version":"29.0.4.1"'), out);
  assert.ok(out.includes('"url":"/index.php/apps/files/"'), out);
  assert.ok(out.includes('/var/www/cloud/data/user-1/files/'), out);
  assert.equal(out.split('\n').length, 2);
});

test('same pseudonyms across conversation and attachment', () => {
  const p = setup();
  p.text('Instance cloud.acme-corp.com, IP 85.214.1.2');
  assert.equal(p.file('host=cloud.acme-corp.com ip=85.214.1.2'), 'host=cloud.domain1.example ip=192.0.2.1');
});
