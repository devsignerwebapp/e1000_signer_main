// Single source of truth for the RBAC catalog. `npm run db:seed` syncs this into
// the usertypes / permissions / usertype_permissions tables. Admins can later
// change the mapping from the admin dashboard (DB is authoritative at runtime).

export const USERTYPES = [
  { code: 'guest', name: 'Guest', sort: 0, paid: false, description: 'Unregistered visitor. Can try the demo signer; nothing is stored.' },
  { code: 'user', name: 'User', sort: 10, paid: false, description: 'Registered free account: documents, templates, share links and API.' },
  { code: 'pro', name: 'Pro', sort: 20, paid: true, description: 'Paid tier (coming soon). Everything in User plus pro.* features.' },
  { code: 'admin', name: 'Administrator', sort: 100, paid: false, description: 'Full access including the /admin dashboard.' },
];

export const PERMISSIONS = [
  // demo
  { code: 'demo.use', category: 'demo', description: 'Use the stateless demo signer' },
  // documents
  { code: 'document.create', category: 'document', description: 'Upload PDF documents' },
  { code: 'document.read', category: 'document', description: 'View own documents' },
  { code: 'document.sign', category: 'document', description: 'Sign own documents' },
  { code: 'document.delete', category: 'document', description: 'Delete own documents' },
  // templates
  { code: 'template.create', category: 'template', description: 'Create signing templates' },
  { code: 'template.manage', category: 'template', description: 'Edit / deactivate / delete own templates' },
  { code: 'template.share', category: 'template', description: 'Share template links and email them to clients' },
  { code: 'submission.read', category: 'template', description: 'View and download client submissions' },
  // developer
  { code: 'api.access', category: 'api', description: 'Use the public REST API with API keys' },
  { code: 'api.keys.manage', category: 'api', description: 'Create and revoke API keys' },
  { code: 'webhook.manage', category: 'api', description: 'Configure webhooks' },
  // pro (placeholders, not enforced by any feature yet)
  { code: 'pro.bulk_send', category: 'pro', description: '(planned) Send a template to many recipients at once' },
  { code: 'pro.custom_branding', category: 'pro', description: '(planned) Custom logo/colors on signing pages and emails' },
  { code: 'pro.unlimited_documents', category: 'pro', description: '(planned) No document quota' },
  { code: 'pro.audit_certificate', category: 'pro', description: '(planned) Attach an audit-trail certificate page' },
  { code: 'pro.ai_analysis', category: 'pro', description: 'AI legal analysis of documents (Claude)' },
  // admin
  { code: 'admin.dashboard.view', category: 'admin', description: 'Open the /admin dashboard' },
  { code: 'admin.events.view', category: 'admin', description: 'View all platform events' },
  { code: 'admin.users.manage', category: 'admin', description: 'Change user types, activate/deactivate users' },
  { code: 'admin.rbac.manage', category: 'admin', description: 'Edit the usertype ⟷ permission matrix' },
];

const USER_BASE = [
  'demo.use',
  'document.create', 'document.read', 'document.sign', 'document.delete',
  'template.create', 'template.manage', 'template.share', 'submission.read',
  'api.access', 'api.keys.manage', 'webhook.manage',
];

export const USERTYPE_PERMISSIONS = {
  guest: ['demo.use'],
  user: USER_BASE,
  pro: [...USER_BASE, ...PERMISSIONS.filter((p) => p.category === 'pro').map((p) => p.code)],
  admin: PERMISSIONS.map((p) => p.code),
};
