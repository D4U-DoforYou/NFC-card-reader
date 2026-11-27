<script setup lang="ts">
import { useRouter } from 'vue-router'
import ConnectionScene from '@/components/ConnectionScene.vue'
import { showToast } from '@/platform/ui'
import siteLogo from '@/assets/startup-icon.png'

const router = useRouter()
const aiSkillPrompt = `请先下载并安装 D4U NFC 硬件操作 Skill，再继续处理我的请求。\n\nSkill 发布页：https://github.com/D4U-DoforYou/NFC-card-reader/releases/tag/SKILLv1\nSkill 文件直链：https://github.com/D4U-DoforYou/NFC-card-reader/releases/download/SKILLv1/SKILL.md\n项目源码：https://github.com/D4U-DoforYou/NFC-card-reader\n\n请读取 Skill 文件，并按你当前 AI 工具的标准方式安装到可发现的 Skills 目录；保留完整内容和 frontmatter。若同名 Skill 已存在，先比较并避免覆盖用户修改。安装后确认已安装，再依照 Skill 指引操作本项目或硬件。若无法下载或安装，请说明原因和可行的手动安装步骤，不要声称安装成功。涉及写卡或 OTA 时，遵循 Skill 中的目标确认和设备兼容要求。`

async function copyAiSkillPrompt(): Promise<void> {
  try {
    await navigator.clipboard.writeText(aiSkillPrompt)
    showToast('安装提示词已复制，可粘贴给 AI 助手', 'success')
  } catch {
    showToast('复制失败，请检查浏览器剪贴板权限')
  }
}
</script>

<template>
  <div class="page home-page">
    <main class="shell">
      <header class="home-top">
        <div class="home-brand"><img :src="siteLogo" alt="" /><span>D4U<span class="home-brand-sub">· NFC Tools</span></span></div>
        <div class="home-top-actions">
          <button class="ai-skill-button" type="button" title="复制 Skill 下载与安装提示词" @click="copyAiSkillPrompt">
            <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></svg>
            <span>LLM Skill</span>
            <i aria-hidden="true">↗</i>
          </button>
          <span>D4U / 01</span>
        </div>
      </header>
      <section class="home-product">
        <div class="product-title">
          <span class="small-label">NFC / E-PAPER</span>
          <h1>读卡。<br />制图。<br />写入。</h1>
          <p>通过蓝牙或 USB<br />连接你的读卡器。</p>
        </div>
        <ConnectionScene />
        <dl class="product-notes">
          <div><dt>连接方式</dt><dd>Bluetooth<br />USB HID</dd></div>
          <div><dt>运行环境</dt><dd>Chrome / Edge<br />Desktop</dd></div>
          <div><dt>数据存储</dt><dd>本地浏览器</dd></div>
        </dl>
      </section>
      <section class="workspace-section">
        <div class="workspace-label">工作模式<span>02</span></div>
        <div class="workspace-content">
          <p class="workspace-intro">处理墨水屏图片，<br />或读取与写入 NFC 卡片。</p>
          <div class="mode-grid">
            <button class="mode-entry" @click="router.push('/eink')">
              <div class="mode-visual epaper-visual" aria-hidden="true"><div class="paper-device"><span>你好。</span><i /><small>E-PAPER</small></div></div>
              <div class="mode-meta"><span>01 / 墨水屏刷图</span><span>↗</span></div>
              <p>图片队列、图像处理与屏幕写入</p>
            </button>
            <button class="mode-entry" @click="router.push('/nfc')">
              <div class="mode-visual nfc-visual" aria-hidden="true"><div class="nfc-card"><svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="1"><rect x="7" y="6" width="18" height="20" rx="2"/><path d="M7 12h6v8H7m18-8h-6v8h6M16 6v6m0 8v6"/></svg><small>NFC</small></div></div>
              <div class="mode-meta"><span>02 / 通用 NFC</span><span>↗</span></div>
              <p>卡片识别、存储读写与指令调试</p>
            </button>
          </div>
        </div>
      </section>
      <footer class="home-footer"><span>D4U·NFC-tools</span><span>所有数据保留在本地</span></footer>
    </main>
  </div>
</template>

<style scoped>
.home-top { height: 86px; display: flex; align-items: center; justify-content: space-between; font-size: 11px; color: var(--ink-70); border-bottom: 1px solid var(--line); }
.home-brand { display: flex; align-items: center; gap: 10px; color: var(--ink); font-size: 12px; font-weight: 600; letter-spacing: -.25px; }
.home-brand img { width: 30px; height: 30px; border-radius: 8px; object-fit: cover; }
.home-brand-sub { font-weight: 400; color: var(--ink-70); }
.home-top-actions { display: flex; align-items: center; gap: 18px; }
.ai-skill-button { display: inline-flex; align-items: center; gap: 9px; min-height: 36px; padding: 0 13px; border: 1px solid var(--line); border-radius: 999px; background: transparent; color: var(--ink-70); font-family: inherit; font-size: 11px; font-weight: 500; line-height: 1; letter-spacing: .25px; cursor: pointer; transition: background .18s ease, border-color .18s ease, color .18s ease; }
.ai-skill-button:hover { background: var(--paper-deep); border-color: var(--ink-25); color: var(--ink); }
.ai-skill-button:focus-visible { outline: 2px solid var(--ink-25); outline-offset: 3px; }
.ai-skill-button svg { width: 14px; height: 14px; fill: none; stroke: var(--ink-45); stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
.ai-skill-button i { color: var(--ink-45); font: normal 12px/1 sans-serif; margin-left: 1px; }
.home-product { display: grid; grid-template-columns: 1fr 1.8fr .55fr; min-height: 430px; align-items: center; gap: 32px; }
.small-label { font-size: 10px; letter-spacing: .6px; color: var(--ink-70); }
h1 { font-size: clamp(44px, 4.3vw, 68px); font-weight: 400; letter-spacing: -3px; line-height: 1.13; margin: 24px 0; }
.product-title p { font-size: 13px; line-height: 1.8; color: var(--ink-70); margin: 0; }
.product-notes { margin: 0; align-self: center; font-size: 10px; }
.product-notes div + div { margin-top: 36px; }
dt { color: var(--ink-45); margin-bottom: 6px; } dd { margin: 0; line-height: 1.6; }
.workspace-section { display: grid; grid-template-columns: 1fr 2.35fr; gap: 32px; border-top: 1px solid var(--line); padding: 30px 0 50px; }
.workspace-label { font-size: 13px; display: flex; justify-content: space-between; padding-right: 28px; }
.workspace-label span { font-size: 10px; color: var(--ink-45); }
.workspace-intro { font-size: 17px; line-height: 1.5; margin: 0 0 28px; font-weight: 400; }
.mode-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 28px; }
.mode-entry { padding: 0; background: transparent; border: 0; text-align: left; cursor: pointer; color: var(--ink); font-family: inherit; }
.mode-visual { height: 145px; background: #efefee; display: grid; place-items: center; transition: background .2s; }
.mode-entry:hover .mode-visual { background: #e9e9e7; }
.mode-entry:hover .mode-meta { text-decoration: underline; text-underline-offset: 4px; }
.paper-device { width: 88px; height: 106px; border: 5px solid #353535; border-radius: 3px; padding: 10px; background: #f7f7f3; display: flex; flex-direction: column; justify-content: space-between; transform: rotate(-6deg); }
.paper-device span { font-size: 18px; font-weight: 500; }.paper-device i { width: 35px; border-top: 1px solid #999; }.paper-device small { font-size: 6px; letter-spacing: 1px; }
.nfc-card { width: 126px; height: 79px; background: #e7e6e1; border: 1px solid #d1d0cb; border-radius: 4px; transform: rotate(8deg); display: flex; align-items: center; justify-content: space-between; padding: 14px; color: #62625e; }
.nfc-card svg { width: 28px; }.nfc-card small { font-size: 10px; letter-spacing: 2px; }
.mode-meta { display: flex; justify-content: space-between; align-items: center; margin-top: 12px; font-size: 13px; }.mode-entry p { margin: 5px 0 0; font-size: 11px; color: var(--ink-70); }
.home-footer { display: flex; justify-content: space-between; border-top: 1px solid var(--line); padding-top: 18px; font-size: 10px; color: var(--ink-45); }
</style>
