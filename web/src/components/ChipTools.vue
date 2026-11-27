<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import { epdSession } from '@/core/rf/session'
import { parseHex } from '@/core/nfc/hex'
import { toHex } from '@/core/hex'
import { showModal } from '@/platform/ui'
const props = defineProps<{ available: boolean; connected: boolean; busy: boolean; uid: string }>()
const emit = defineEmits<{ busy: [value: boolean] }>()
const address = ref('0B'), value = ref('00'), command = ref(0), fifo = ref(''), result = ref('')
const commands = [{id:0,label:'IDLE'},{id:2,label:'LOADKEY'},{id:3,label:'MFAUTHENT'},{id:5,label:'RECEIVE'},{id:6,label:'TRANSMIT'},{id:7,label:'TRANSCEIVE'},{id:13,label:'LOADPROTOCOL'},{id:28,label:'READRNR'}]
onBeforeUnmount(() => { fifo.value = '' })
watch(command, () => { fifo.value = ''; result.value = '' })
function byte(input: string): number { if (!/^[a-f0-9]{1,2}$/i.test(input.trim())) throw new Error('请输入一字节十六进制数'); return Number.parseInt(input,16) }
async function run(operation: 'read' | 'write' | 'command') {
  if (props.busy || !props.available || !props.connected) return
  emit('busy',true); result.value = ''
  try {
    if (operation === 'read') {
      const actual = await epdSession.rfBridge.readChipRegister(byte(address.value))
      value.value = actual.toString(16).padStart(2,'0').toUpperCase(); result.value = `寄存器 0x${address.value} = 0x${value.value}`
    } else if (operation === 'write') {
      const register = byte(address.value), data = byte(value.value)
      if (!await showModal({title:'写入芯片寄存器',content:`寄存器 0x${register.toString(16)} → 0x${data.toString(16)}\n仅允许协议和定时器配置，以及清除 Crypto1 状态。`,confirmText:'写入寄存器'})) return
      await epdSession.rfBridge.writeChipRegister(register,data); result.value = '寄存器写入完成'
    } else {
      const uid = parseHex(props.uid)
      if (![4,7,10].includes(uid.length)) throw new Error('请先识别卡片，绑定目标 UID')
      const id = command.value, bytes = parseHex(fifo.value)
      try {
        if (!await showModal({title:'执行芯片命令',content:`命令：${commands.find(c=>c.id===id)?.label}\n目标 UID：${toHex(uid)}\nFIFO 输入：${bytes.length} 字节`,confirmText:'执行命令'})) return
        const reply = await epdSession.rfBridge.executeChipCommand(id,bytes,{timeoutMs:100,confirmedTargetUid:uid})
        result.value = `IRQ0=0x${reply.irq0.toString(16)} ERROR=0x${reply.error.toString(16)} STATUS=0x${reply.status.toString(16)}\nFIFO：${toHex(reply.fifoOutput) || '空'}`
      } finally { bytes.fill(0); if (id === 2) fifo.value = '' }
    }
  } catch (error) { result.value = operation === 'command' && command.value === 2 ? 'LOADKEY 未完成，请核对 6 字节密钥与设备连接' : error instanceof Error ? error.message : String(error) }
  finally { emit('busy',false) }
}
</script>

<template>
  <details class="card card-pad chip-tools">
    <summary>芯片命令与寄存器 <span>raw RF 1.2</span></summary>
    <p v-if="!available" class="hint">当前固件未声明芯片原语能力，请升级后重新连接。</p>
    <template v-else>
      <div class="chip-columns">
        <div><div class="field-label">寄存器</div><div class="chip-fields"><label class="field-label">地址（hex）<input v-model="address" class="input" aria-label="寄存器地址" :disabled="busy" /></label><label class="field-label">值（hex）<input v-model="value" class="input" aria-label="寄存器值" :disabled="busy" /></label></div><div class="chip-buttons"><button class="btn btn-dark btn-sm" :disabled="busy || !connected" @click="run('read')">读取寄存器</button><button class="btn btn-ghost btn-sm" :disabled="busy || !connected" @click="run('write')">写入寄存器</button></div></div>
        <div><label class="field-label">芯片命令<select v-model.number="command" class="input" aria-label="芯片命令" :disabled="busy"><option v-for="item in commands" :key="item.id" :value="item.id">{{ item.label }}</option></select></label><label class="field-label">FIFO 输入（hex）<input v-model="fifo" class="input" :type="command === 2 ? 'password' : 'text'" autocomplete="off" placeholder="命令所需字节；可留空" :disabled="busy" /></label><button class="btn btn-dark btn-sm" :disabled="busy || !connected" @click="run('command')">执行芯片命令</button></div>
      </div>
      <pre v-if="result" class="result-box" role="status">{{ result }}</pre>
    </template>
  </details>
</template>

<style scoped>
.chip-tools { margin-top: 20px; }.chip-tools summary { cursor: pointer; font-size: 13px; }.chip-tools summary span { font-size: 10px; color: var(--ink-45); margin-left: 12px; }.chip-columns { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; margin-top: 20px; }.chip-fields { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }.chip-columns .input { margin: 6px 0 14px; }.chip-buttons { display: flex; flex-wrap: wrap; gap: 10px; }
</style>
