/**
 * Classic 射频操作入口。
 *
 * 原先只拼接 AUTH / READ 帧的实现没有完整 Crypto1 会话，已替换。
 * 通过 MifareClassicSession 使用控制器的 LOADKEY / MFAUTHENT 认证、
 * 加密读写与回读校验，关闭会话时清除控制器密钥。
 */
export { MifareClassicSession } from './mifareClassic'
