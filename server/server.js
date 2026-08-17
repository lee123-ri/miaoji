import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { initDb } from './db.js';
import authRoutes from './routes/auth.js';
import householdRoutes from './routes/households.js';

const PORT = process.env.PORT || 3000;
initDb();

const app = express();
app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => res.json({ ok: true, ts: Date.now() }));
app.use('/api/auth', authRoutes);
app.use('/api/households', householdRoutes);

// 404
app.use((req, res) => res.status(404).json({ error: 'not found' }));

// 兜底错误处理
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'internal error' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`喵迹后端 listening on :${PORT}`);
});
