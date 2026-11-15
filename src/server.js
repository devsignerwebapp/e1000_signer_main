import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import morgan from 'morgan';
import { env } from './config/env.js';
import { pool } from './db/pool.js';
import { authenticate } from './middleware/auth.js';
import { errorHandler, notFoundHandler } from './middleware/common.js';
import authRoutes from './routes/auth.js';
import documentRoutes from './routes/documents.js';
import templateRoutes from './routes/templates.js';
import publicRoutes from './routes/public.js';
import accountRoutes from './routes/account.js';
import adminRoutes from './routes/admin.js';
import v1Routes from './routes/v1.js';
import aiRoutes from './routes/ai.js';
import { embedScript } from './routes/embed.js';

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
// /api/v1 and /embed.js are meant to be called from anywhere; the app API only from the web origin.
const openCors = cors({ exposedHeaders: ['Content-Disposition'] });
const webCors = cors({ origin: env.corsOrigins, exposedHeaders: ['Content-Disposition'] });
app.use((req, res, next) => (req.path.startsWith('/api/v1') ? openCors : webCors)(req, res, next));
app.use(express.json({ limit: '40mb' }));
app.use(morgan(env.nodeEnv === 'production' ? 'combined' : 'dev'));

app.get('/api/health', async (_req, res) => {
  await pool.query('SELECT 1');
  res.json({ ok: true, app: env.appName, time: new Date().toISOString() });
});
app.get('/embed.js', cors(), embedScript);

app.use('/api/v1', v1Routes);
app.use('/api', authenticate);
app.use('/api/auth', authRoutes);
app.use('/api/public', publicRoutes);
app.use('/api/documents', documentRoutes);
app.use('/api/templates', templateRoutes);
app.use('/api/account', accountRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/ai', aiRoutes);

app.use(notFoundHandler);
app.use(errorHandler);

app.listen(env.port, () => console.log(`▶ ${env.appName} API listening on ${env.apiPublicUrl} (port ${env.port})`));
