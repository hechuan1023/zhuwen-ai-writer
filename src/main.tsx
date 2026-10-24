import React from 'react'
import ReactDOM from 'react-dom/client'
import App, { AiFloatApp } from './App'
import './styles.css'
import './themes.css'
import './design-tokens.css'
import './cursor-layout.css'
import './personalization.css'
import './chat.css'
import './scene-planner.css'
const isFloat = window.location.hash.includes('ai-float')
ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode>{isFloat ? <AiFloatApp/> : <App/>}</React.StrictMode>)
