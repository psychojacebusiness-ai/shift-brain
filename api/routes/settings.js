import { Router } from 'express'
import { supabase } from '../lib/supabase.js'
import { requireAuth, requireAdmin } from '../middleware/auth.js'

const ASSET_BASE_URL = 'https://shift-brain-production.up.railway.app/assets'
const LEGACY_FIGMA_ASSET_PREFIX = 'https://www.figma.com/api/mcp/asset/'

const DEFAULT_SETTINGS = {
  brain_icon_url: `${ASSET_BASE_URL}/brain-icon.png`,
  login_logo_width: '91',
  plus_base_icon_url: `${ASSET_BASE_URL}/plus-base.svg`,
  plus_glyph_icon_url: `${ASSET_BASE_URL}/plus-glyph.svg`,
  send_base_icon_url: `${ASSET_BASE_URL}/send-base.svg`,
  send_glyph_icon_url: `${ASSET_BASE_URL}/send-glyph.svg`,
  sidebar_open_icon_url: `${ASSET_BASE_URL}/sidebar-open.svg`,
  sidebar_close_icon_url: `${ASSET_BASE_URL}/sidebar-close.svg`,
  search_icon_url: `${ASSET_BASE_URL}/search.svg`,
  upload_file_icon_url: `${ASSET_BASE_URL}/upload-file.svg`,
  send_message_icon_url: `${ASSET_BASE_URL}/send-message.svg`,
  color_cream: '#fdfbef',
  color_ink: '#0b0b2d',
  color_pink: '#ff008f',
  color_purple: '#302798',
  color_muted: '#b7b7b7',
  color_yellow: '#ffd000',
  color_white: '#ffffff',
  color_line: '#deddd5',
  color_soft_pink: '#ffc2df',
  color_success: '#2d7a3a',
  color_danger: '#c53030',
  login_heading: 'Hello there!',
  login_intro: 'I’m SHIFT Brain (BETA), a Fun (AI)dult that’s been trained on all the resources, tools and knowledge gathered over the last 6 years.',
  login_emphasis: 'Ask me anything related to SHIFT!',
  login_email_placeholder: 'Email',
  login_password_placeholder: 'Password',
  login_forgot_password: 'Forgot password?',
  login_create_account: 'Create an account',
  login_button: 'LOG IN',
  signup_pending_heading: 'Your account is awaiting approval',
  signup_pending_message: 'A curator needs to approve your signup before you can access SHIFT Brain. You can leave this page and return later.',
  dashboard_title: 'Curator Dashboard',
  dashboard_back_to_chat: '← Back to chat',
  dashboard_participants: 'Participants',
  dashboard_conversations: 'Conversations',
  dashboard_knowledge: 'Knowledge base',
  dashboard_usage: 'Usage stats',
  dashboard_settings: 'Settings',
  chat_welcome: 'Let’s start building your movement today!'
}

const URL_FIELDS = ['brain_icon_url', 'plus_base_icon_url', 'plus_glyph_icon_url', 'send_base_icon_url', 'send_glyph_icon_url', 'sidebar_open_icon_url', 'sidebar_close_icon_url', 'search_icon_url', 'upload_file_icon_url', 'send_message_icon_url']
const COLOR_FIELDS = ['color_cream', 'color_ink', 'color_pink', 'color_purple', 'color_muted', 'color_yellow', 'color_white', 'color_line', 'color_soft_pink', 'color_success', 'color_danger']
const SIZE_FIELDS = ['login_logo_width']
const TEXT_FIELDS = Object.keys(DEFAULT_SETTINGS).filter(key => !URL_FIELDS.includes(key) && !COLOR_FIELDS.includes(key) && !SIZE_FIELDS.includes(key))

function cleanSettings(input = {}) {
  const next = { ...DEFAULT_SETTINGS }

  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (input[key] === undefined || input[key] === null) continue
    const value = String(input[key]).trim()
    if (value.length > 2000) continue
    next[key] = value
  }

  for (const key of URL_FIELDS) {
    const value = next[key].trim()
    if (!value) {
      next[key] = ''
      continue
    }
    if (value.startsWith(LEGACY_FIGMA_ASSET_PREFIX)) {
      next[key] = DEFAULT_SETTINGS[key]
      continue
    }
    try {
      const url = new URL(value)
      if (!['http:', 'https:'].includes(url.protocol)) next[key] = DEFAULT_SETTINGS[key]
    } catch {
      next[key] = DEFAULT_SETTINGS[key]
    }
  }

  for (const key of COLOR_FIELDS) {
    if (!/^#[0-9a-f]{6}$/i.test(next[key])) next[key] = DEFAULT_SETTINGS[key]
  }

  for (const key of SIZE_FIELDS) {
    const size = Number.parseFloat(next[key])
    next[key] = String(Number.isFinite(size) ? Math.min(320, Math.max(40, size)) : DEFAULT_SETTINGS[key])
  }

  for (const key of TEXT_FIELDS) {
    if (!next[key]) next[key] = DEFAULT_SETTINGS[key]
  }

  return next
}

async function readSettings() {
  const { data, error } = await supabase
    .from('app_settings')
    .select('value')
    .eq('key', 'branding')
    .maybeSingle()

  if (error) throw error
  return cleanSettings(data?.value || {})
}

const PUBLIC_CACHE_MS = 5 * 60 * 1000
const PUBLIC_RATE_WINDOW_MS = 60 * 1000
const PUBLIC_RATE_LIMIT = 60
let settingsCache = { value: null, expiresAt: 0 }
const publicRequestWindows = new Map()

function publicConfigRateLimit(req, res, next) {
  const now = Date.now()
  if (publicRequestWindows.size > 1_000) {
    for (const [windowKey, window] of publicRequestWindows) {
      if (window.resetAt <= now) publicRequestWindows.delete(windowKey)
    }
  }
  const key = req.ip || 'unknown'
  const current = publicRequestWindows.get(key)
  if (!current || current.resetAt <= now) {
    publicRequestWindows.set(key, { count: 1, resetAt: now + PUBLIC_RATE_WINDOW_MS })
    return next()
  }
  if (current.count >= PUBLIC_RATE_LIMIT) {
    return res.status(429).json({ error: 'Too many configuration requests' })
  }
  current.count += 1
  return next()
}

async function readCachedSettings() {
  if (settingsCache.value && settingsCache.expiresAt > Date.now()) {
    return settingsCache.value
  }
  const settings = await readSettings()
  settingsCache = { value: settings, expiresAt: Date.now() + PUBLIC_CACHE_MS }
  return settings
}

export const publicSettingsRouter = Router()
publicSettingsRouter.get('/', publicConfigRateLimit, async (req, res) => {
  try {
    const settings = await readCachedSettings()
    res.set('Cache-Control', 'public, max-age=60, stale-while-revalidate=300')
    res.json({ settings, clerkPublishableKey: process.env.CLERK_PUBLISHABLE_KEY || process.env.VITE_CLERK_PUBLISHABLE_KEY || null })
  } catch (err) {
    // Keep the public login usable even before the settings table is created.
    console.error('Public settings error:', err)
    settingsCache = { value: DEFAULT_SETTINGS, expiresAt: Date.now() + 60_000 }
    res.set('Cache-Control', 'public, max-age=30')
    res.json({ settings: DEFAULT_SETTINGS, clerkPublishableKey: process.env.CLERK_PUBLISHABLE_KEY || process.env.VITE_CLERK_PUBLISHABLE_KEY || null })
  }
})

export const adminSettingsRouter = Router()
adminSettingsRouter.use(requireAuth, requireAdmin)

adminSettingsRouter.get('/', async (req, res) => {
  try {
    res.json({ settings: await readCachedSettings() })
  } catch (err) {
    console.error('Admin settings read error:', err)
    res.status(500).json({ error: 'Failed to load settings' })
  }
})

adminSettingsRouter.patch('/', async (req, res) => {
  try {
    const settings = cleanSettings(req.body || {})
    const { data, error } = await supabase
      .from('app_settings')
      .upsert({ key: 'branding', value: settings, updated_at: new Date().toISOString() }, { onConflict: 'key' })
      .select('value')
      .single()

    if (error) throw error
    const savedSettings = cleanSettings(data?.value || settings)
    settingsCache = { value: savedSettings, expiresAt: Date.now() + PUBLIC_CACHE_MS }
    res.json({ settings: savedSettings })
  } catch (err) {
    console.error('Admin settings save error:', err)
    res.status(500).json({ error: 'Failed to save settings' })
  }
})

export { DEFAULT_SETTINGS }
