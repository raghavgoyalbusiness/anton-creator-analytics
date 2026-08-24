import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { CreatorApp } from './creator/CreatorApp.jsx';
import { OperatorApp } from './operator/OperatorApp.jsx';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('#root is missing from index.html');

createRoot(root).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/c/:token" element={<CreatorApp />} />
        <Route path="/c" element={<CreatorApp />} />
        <Route path="/ops" element={<OperatorApp />} />
        <Route path="*" element={<Navigate to="/c" replace />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);
