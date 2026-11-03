import '@fontsource-variable/noto-sans-sc'
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { initTheme } from './lib/theme'
import './styles.css'

// 应用启动前先根据 localStorage 缓存应用主题（首帧 index.html 已做一次防闪白）。
initTheme()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
