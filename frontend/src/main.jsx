import { HashRouter, Routes, Route } from 'react-router-dom'
import { ClerkProvider } from '@clerk/clerk-react'
import App from './App.jsx'
import ProfilePage from './ProfilePage.jsx'
import './index.css'

const PUBLISHABLE_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY

import { createRoot } from 'react-dom/client'

// Tree of routes — works with or without Clerk
const AppTree = (
  <HashRouter>
    <Routes>
      <Route path="/" element={<App />} />
      <Route path="/profile" element={<ProfilePage />} />
    </Routes>
  </HashRouter>
)

// If no Clerk key is configured, run in pure guest mode (no ClerkProvider).
// App.jsx detects this via the absence of the provider context and skips auth-only flows.
createRoot(document.getElementById('root')).render(
  PUBLISHABLE_KEY ? (
    <ClerkProvider publishableKey={PUBLISHABLE_KEY} afterSignOutUrl="/">
      {AppTree}
    </ClerkProvider>
  ) : (
    AppTree
  )
)
