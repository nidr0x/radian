import { useEffect, useState } from 'react'
import { Button, TextField } from './ui.jsx'
import { t } from '../lib/i18n.js'
import { getPairingV2Client } from '../lib/pairing-v2-sync.js'

const errorText = error => ({
  pair_not_found: t('No encrypted copy was found for this code.'),
  pair_expired: t('This encrypted pairing has expired.'),
  pair_revoked: t('This encrypted pairing was revoked.'),
  pair_already_active: t('Revoke the current pairing before creating another.'),
  legacy_pair_not_found: t('No Radian copy was found for that code.'),
  invalid_pair_state: t('The encrypted copy has an unsupported format.'),
  pair_readback_mismatch: t('The new encrypted copy could not be verified.'),
})[error] || t('The encrypted pairing could not be completed.')

export default function EncryptedPairing({ close }) {
  const client = getPairingV2Client()
  const [status, setStatus] = useState(() => client?.getStatus() || { active: false })
  const [link, setLink] = useState(status.link || '')
  const [legacyKey, setLegacyKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')

  useEffect(() => client?.subscribe(next => { setStatus(next); if (next.link) setLink(next.link) }), [client])

  const run = async action => {
    setBusy(true)
    setMessage('')
    try {
      const result = await action()
      if (result?.link) setLink(result.link)
      setMessage(t('Encrypted pairing is ready.'))
    } catch (error) {
      setMessage(errorText(error?.message))
    } finally { setBusy(false) }
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link)
      setMessage(t('Link copied.'))
    } catch { setMessage(t('Select and copy the link manually.')) }
  }

  const revoke = async () => {
    if (!window.confirm(t('Revoke this encrypted pairing? Devices using its link will stop syncing.'))) return
    await run(() => client.revoke())
    setLink('')
  }

  return <>
    <h3>{t('Encrypted device sync')}</h3>
    <p className="muted small">{t('Create a reusable link to sync an encrypted copy between devices. Anyone with the link can access the channel, so share it only with trusted devices. This tab keeps the master code in session storage for reloads; the AES key stays in memory, while a separate authorization key is used for requests. Reopen the link after closing this tab.')}</p>
    {status.active ? <>
      <p className="small">{status.syncing ? t('Syncing…') : t('Connected')} · {t('Revision')} {status.revision}</p>
      {!status.restorable && <p className="small" role="alert">{t('This tab cannot remember the code. Copy the link somewhere safe so you can reopen it after a reload.')}</p>}
      {link && <TextField aria-label={t('Encrypted pairing link')} value={link} readOnly onFocus={event => event.target.select()} />}
      <div className="row-actions">
        {link && <Button onClick={copy}>{t('Copy link')}</Button>}
        <Button variant="danger" onClick={revoke} disabled={busy}>{t('Revoke pairing')}</Button>
      </div>
    </> : <>
      <Button onClick={() => run(() => client.create())} disabled={busy}>{t('Create encrypted link')}</Button>
      <div className="small muted" style={{ margin: '12px 0 6px' }}>{t('Have an older Radian sync code? Enter it to migrate its encrypted copy into a verified v2 link. The original remains available.')}</div>
      <TextField type="password" aria-label={t('Radian sync code')} value={legacyKey} onChange={event => setLegacyKey(event.target.value)} autoComplete="off" spellCheck="false" />
      <Button onClick={() => run(async () => { const result = await client.migrateLegacy(legacyKey); setLegacyKey(''); return result })} disabled={busy || !legacyKey.trim()}>{t('Migrate Radian copy')}</Button>
      {link && <>
        <TextField aria-label={t('Encrypted pairing link')} value={link} readOnly onFocus={event => event.target.select()} />
        <Button onClick={copy}>{t('Copy link')}</Button>
      </>}
    </>}
    {message && <p className="small" role="status">{message}</p>}
    {status.error && <p className="small" role="alert">{errorText(status.error)}</p>}
    <div style={{ height: 12 }} />
    <Button onClick={close}>{t('Done')}</Button>
  </>
}
