/**
 * Vercel entry point (zero-config Express: Vercel looks for src/index.ts and uses its
 * default export as one function). No listen(), no background loops: Vercel Cron
 * calls /api/cron/* instead (see vercel.json). Elsewhere, run src/server.ts.
 */
import express from 'express';
import { createApp } from './http/app.js';

const app = express();
app.disable('x-powered-by');
app.use(createApp());

export default app;
