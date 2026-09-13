import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ControlTower } from './control-tower';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ControlTower />
  </StrictMode>,
);
