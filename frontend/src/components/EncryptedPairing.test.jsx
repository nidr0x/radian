/* @vitest-environment happy-dom */
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { client } = vi.hoisted(() => ({
  client: { getStatus: vi.fn(), subscribe: vi.fn(), revoke: vi.fn() }
}))

vi.mock('../lib/i18n.js', () => ({ t: key => key }))
vi.mock('../lib/pairing-v2-sync.js', () => ({ getPairingV2Client: () => client }))

import EncryptedPairing from './EncryptedPairing.jsx'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

describe('encrypted pairing controls', () => {
  let host, root

  beforeEach(() => {
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    client.getStatus.mockReturnValue({ active: true, link: 'https://example.test/pair#secret', revision: 3, restorable: true })
    client.subscribe.mockReturnValue(() => {})
    client.revoke.mockResolvedValue(false)
    window.confirm = vi.fn(() => true)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    host.remove()
    delete window.confirm
    vi.restoreAllMocks()
  })

  it('keeps the link and reports no success when revoke returns false', async () => {
    await act(async () => root.render(<EncryptedPairing close={() => {}} />))

    const link = host.querySelector('input[aria-label="Encrypted pairing link"]')
    expect(link?.value).toBe('https://example.test/pair#secret')

    const revoke = [...host.querySelectorAll('button')].find(button => button.textContent === 'Revoke pairing')
    await act(async () => revoke.dispatchEvent(new MouseEvent('click', { bubbles: true })))

    expect(client.revoke).toHaveBeenCalledOnce()
    expect(host.querySelector('input[aria-label="Encrypted pairing link"]')?.value).toBe('https://example.test/pair#secret')
    expect(host.querySelector('[role="status"]')?.textContent).not.toBe('Encrypted pairing is ready.')
  })
})
