import type { CardIdentification } from './cards'

type CardSummary = Pick<CardIdentification, 'protocol' | 'modelId'>
export interface CardAppearance {
  key: string
  title: string
  mark: string
  pattern: 'waves' | 'grid' | 'rings' | 'stripes' | 'dots' | 'screen' | 'circuit'
  background: string
  ink: string
  accent: string
}
const styles: Record<string, CardAppearance> = {
  idle: { key: 'idle', title: '等待识别', mark: 'NFC', pattern: 'waves', background: '#e9ece8', ink: '#7b857c', accent: '#b9c4bb' },
  unknown: { key: 'unknown', title: '未知类型', mark: '?', pattern: 'dots', background: '#edece9', ink: '#726e65', accent: '#b7b2a8' },
  iso14443a: { key: 'iso14443a', title: 'ISO-14443A', mark: 'A', pattern: 'waves', background: '#dce9df', ink: '#385d46', accent: '#8eae96' },
  iso14443b: { key: 'iso14443b', title: 'ISO-14443B', mark: 'B', pattern: 'stripes', background: '#dfe8f4', ink: '#3e5c82', accent: '#9aafce' },
  felica: { key: 'felica', title: 'FeliCa', mark: 'F', pattern: 'rings', background: '#e7e0f0', ink: '#67517e', accent: '#b3a0ca' },
  iso15693: { key: 'iso15693', title: 'ISO-15693', mark: 'V', pattern: 'circuit', background: '#d9ecec', ink: '#356b70', accent: '#8cbabc' },
  'mifare-classic': { key: 'mifare-classic', title: 'MIFARE Classic', mark: 'M', pattern: 'grid', background: '#dce4ee', ink: '#415a79', accent: '#91a6bf' },
  'mifare-plus': { key: 'mifare-plus', title: 'MIFARE Plus', mark: '+', pattern: 'grid', background: '#e2e9d8', ink: '#596b38', accent: '#acbb8b' },
  'mifare-desfire': { key: 'mifare-desfire', title: 'MIFARE DESFire', mark: 'D', pattern: 'stripes', background: '#eddfd7', ink: '#8b513c', accent: '#c29c86' },
  ultralight: { key: 'ultralight', title: 'Ultralight / NTAG', mark: 'N', pattern: 'dots', background: '#f0e8d4', ink: '#8a6b34', accent: '#ccb783' },
  'iso-dep': { key: 'iso-dep', title: 'ISO-DEP', mark: '4', pattern: 'circuit', background: '#e0e3ef', ink: '#515d87', accent: '#9ca6c5' },
  'epaper-tag': { key: 'epaper-tag', title: 'E-PAPER', mark: 'E', pattern: 'screen', background: '#ebe8df', ink: '#655f50', accent: '#b9b19e' },
}

/** Present the reported identification; appearance never changes detection. */
export function cardAppearance(info: CardSummary | null): CardAppearance {
  if (!info) return styles.idle
  // Models only refine Type A. Other protocols keep their own appearance.
  if (info.protocol === 'iso14443a') {
    const models = ['mifare-classic', 'mifare-plus', 'mifare-desfire', 'ultralight', 'iso-dep', 'epaper-tag']
    return models.includes(info.modelId) ? styles[info.modelId] : styles.iso14443a
  }
  return styles[info.protocol] ?? styles.unknown
}
