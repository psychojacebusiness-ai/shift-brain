export const API_URL = (
  import.meta.env.VITE_API_URL
  || (import.meta.env.DEV ? '/api' : 'https://shift-brain-production-api.up.railway.app')
).replace(/\/$/, '')

async function getHeaders(getToken) {
  const token = await getToken()
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`
  }
}

export async function fetchUsage(getToken) {
  const headers = await getHeaders(getToken)
  const res = await fetch(`${API_URL}/usage/me`, { headers })
  if (!res.ok) throw new Error('Failed to fetch usage')
  return res.json()
}

export async function fetchConversations(getToken) {
  const headers = await getHeaders(getToken)
  const res = await fetch(`${API_URL}/chat/conversations`, { headers })
  if (!res.ok) throw new Error('Failed to fetch conversations')
  return res.json()
}

export async function fetchConversation(getToken, id) {
  const headers = await getHeaders(getToken)
  const res = await fetch(`${API_URL}/chat/conversations/${id}`, { headers })
  if (!res.ok) throw new Error('Failed to fetch conversation')
  return res.json()
}

export async function syncUser(getToken, userData) {
  const headers = await getHeaders(getToken)
  const res = await fetch(`${API_URL}/auth/sync`, {
    method: 'POST',
    headers,
    body: JSON.stringify(userData)
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    const error = new Error(data.details || data.error || 'Failed to sync user')
    error.code = data.code
    throw error
  }
  return res.json()
}

export async function updateFontSize(getToken, fontSize) {
  const headers = await getHeaders(getToken)
  const res = await fetch(`${API_URL}/auth/me`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ font_size: fontSize })
  })
  if (!res.ok) throw new Error('Failed to update font size')
  return res.json()
}

export async function uploadFile(getToken, file) {
  const token = await getToken()
  const formData = new FormData()
  formData.append('file', file)

  const res = await fetch(`${API_URL}/chat/upload`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`
    },
    body: formData
  })

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Upload failed' }))
    throw new Error(err.error || 'Upload failed')
  }
  return res.json()
}

export async function streamChat({
  getToken,
  message,
  conversationId,
  attachment = null,
  onConversationId,
  onText,
  onReaction,
  onCitations,
  onDone,
  onError,
  signal
}) {
  let token
  let res
  try {
    token = await getToken()
    res = await fetch(`${API_URL}/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({
        message,
        conversation_id: conversationId,
        attachment
      }),
      signal
    })
  } catch (error) {
    if (signal?.aborted || error?.name === 'AbortError') return null
    onError({ message: 'Unable to reach SHIFT Brain. Please try again.' })
    return null
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({ message: 'Request failed' }))
    onError({
      ...err,
      status: res.status,
      message: err.message || err.error || `Request failed (${res.status})`
    })
    return null
  }

  const contentType = res.headers.get('content-type') || ''
  if (contentType.includes('application/json')) {
    const data = await res.json()
    if (data.reaction_emoji) {
      onReaction?.({ emoji: data.reaction_emoji, messageId: data.message_id || null })
    }
    if (data.conversation_id) onConversationId?.(data.conversation_id)
    if (data.response) onText(data.response)
    onDone(data)
    return data.conversation_id || null
  }

  if (!res.body) {
    onError({ message: 'The response stream was unavailable. Please try again.' })
    return null
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let conversationId_returned = null
  let pending = ''

  function handleLine(line) {
    if (!line.startsWith('data: ')) return
    try {
      const data = JSON.parse(line.slice(6))
      if (data.type === 'conversation_id') {
        conversationId_returned = data.conversation_id
        onConversationId?.(data.conversation_id)
      } else if (data.type === 'text') {
        onText(data.text)
      } else if (data.type === 'reaction') {
        onReaction?.({ emoji: data.emoji, messageId: data.message_id || null })
      } else if (data.type === 'citations') {
        onCitations(data.citations)
      } else if (data.type === 'done') {
        onDone(data)
      } else if (data.type === 'error') {
        onError(data)
      }
    } catch {
      // Ignore a malformed event without dropping adjacent valid events.
    }
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      pending += decoder.decode(value, { stream: true })
      const lines = pending.split('\n')
      pending = lines.pop() || ''
      lines.forEach(handleLine)
    }

    pending += decoder.decode()
    if (pending) handleLine(pending)
  } catch (error) {
    if (signal?.aborted || error?.name === 'AbortError') return conversationId_returned
    onError({ message: 'The response was interrupted. Please try again.' })
    return conversationId_returned
  }

  return conversationId_returned
}
