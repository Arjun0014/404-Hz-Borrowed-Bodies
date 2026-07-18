import './style.css';
import { GameApp } from './core/GameApp';

const app = new GameApp(document.getElementById('app')!);
app.start().catch((err) => {
  console.error('[404hz] failed to start:', err);
  const el = document.getElementById('loading-text');
  if (el) el.textContent = 'failed to load — check console';
});
