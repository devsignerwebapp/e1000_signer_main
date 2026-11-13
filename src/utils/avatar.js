// Profile photos live in storage under "avatars/<uuid>.<ext>" and are served by
// GET /api/public/avatars/:file (unguessable file name, no auth so <img> tags work).
export const avatarUrl = (avatarPath) => (avatarPath ? `/api/public/avatars/${avatarPath.split('/').pop()}` : null);
