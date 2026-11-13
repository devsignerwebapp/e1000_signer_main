-- Items the template OWNER (sender) signs in advance: their own signature images / text / dates.
-- Same shape as document placements: [{page,x,y,w,h, image?|text?, color?}] (normalized 0..1).
-- They are shown read-only to clients and stamped into every submission together with the client's fields.
ALTER TABLE templates ADD COLUMN IF NOT EXISTS owner_placements JSONB NOT NULL DEFAULT '[]'::jsonb;
