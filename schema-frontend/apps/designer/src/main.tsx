import React from 'react';
import { createRoot } from 'react-dom/client';
import { ConfigProvider, Layout, Typography } from 'antd';

function App() {
  return <ConfigProvider><Layout><Layout.Content><Typography.Title>Schema · designer</Typography.Title><Typography.Paragraph>工程地基已就绪，业务功能按后续里程碑交付。</Typography.Paragraph></Layout.Content></Layout></ConfigProvider>;
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
