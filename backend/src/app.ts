import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import routes from './routes';
import {
  verifyLicenceOrDie,
  enforceLicence,
  currentLicenceInfo,
} from './modules/licence/licence.guard';

const app = express();
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '10mb' }));

app.get('/health', (req, res) => res.json({
  status: 'healthy', version: '5.0', timestamp: new Date().toISOString(),
}));
app.get('/licence/status', (req, res) => res.json(currentLicenceInfo()));

app.use(enforceLicence());
app.use('/api/v1', routes);
app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('Error:', err);
  res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: err.message } });
});

const PORT = process.env.PORT || 3001;

async function bootstrap(): Promise<void> {
  await verifyLicenceOrDie('FTR');
  app.listen(PORT, () => console.log(`IRG_FTR Platform v5.0 running on port ${PORT}`));
}
bootstrap().catch((e) => {
  console.error('Bootstrap failed:', e);
  process.exit(2);
});

export default app;
