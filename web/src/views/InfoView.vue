<script setup lang="ts">
import packageInfo from '../../package.json'
import NavBar from '@/components/NavBar.vue'
import BlePill from '@/components/BlePill.vue'
import { useConnection } from '@/composables/useConnection'
import siteLogo from '@/assets/startup-icon.png'
const { connected, kind, connection } = useConnection()
const softwareVersion = packageInfo.version
const protocolVersion = 'rfplatform.v1 · 1.0'
</script>

<template>
  <div class="page info-page">
    <main class="shell">
      <NavBar title="INFO" subtitle="关于与使用说明" :back="false" />
      <div class="info-content">
        <section class="info-intro">
          <span class="info-label"><img :src="siteLogo" alt="" />D4U · NFC Tools</span>
          <h1>软件介绍</h1>
          <p>本软件适配 D4U 设计的开源 NFC 读卡器硬件，支持蓝牙透传与 HID 透传，可用于墨水屏传图、NFC 卡片读写和设备调试。</p>
          <p class="project-links">
            项目地址：<a href="https://github.com/D4U-DoforYou/NFC-card-reader" target="_blank" rel="noopener noreferrer">GitHub 项目 ↗</a><br />
            提交问题或 Bug：<a href="https://github.com/D4U-DoforYou/NFC-card-reader/issues" target="_blank" rel="noopener noreferrer">GitHub Issues ↗</a>
          </p>
          <div class="info-status"><BlePill @click="$router.push('/connect')" /><span>{{ connected ? connection.name || (kind === 'usb' ? 'USB 读卡器' : '蓝牙读卡器') : '连接设备后即可开始' }}</span></div>
        </section>
        <div class="info-details">
          <section class="info-block info-start">
            <h2>开始使用</h2>
            <ol>
              <li><RouterLink to="/connect">连接设备 ↗</RouterLink><p>选择蓝牙或 USB HID，在浏览器弹窗中授权读卡器。连接页也可选择应用固件进行 OTA 升级。</p></li>
              <li><RouterLink to="/eink">墨水屏刷图 ↗</RouterLink><p>添加图片，调整处理效果，在刷图引导中识别屏幕并写入。</p></li>
              <li><RouterLink to="/nfc">通用 NFC ↗</RouterLink><p>识别卡片，读写 NDEF；Classic 1K 可用已有 Key A / B 认证读写数据块，需要 raw RF 1.2 固件。</p></li>
            </ol>
          </section>
          <section class="info-block info-environment">
            <h2>运行环境</h2>
            <dl><div><dt>浏览器</dt><dd>桌面 Chrome / Edge</dd></div><div><dt>连接</dt><dd>Web Bluetooth / WebHID</dd></div><div><dt>访问方式</dt><dd>HTTPS 或 localhost</dd></div></dl>
            <p>蓝牙与 USB HID 都需要系统和浏览器支持，并由用户在连接弹窗中授权设备。</p>
          </section>
          <section class="info-block info-version">
            <h2>版本信息</h2>
            <dl>
              <div><dt>软件版本</dt><dd>{{ softwareVersion }}</dd></div>
              <div><dt>设备通信协议</dt><dd>{{ protocolVersion }}</dd></div>
            </dl>
          </section>
          <section class="info-block info-devices">
            <h2>支持设备</h2>
            <ul><li><strong>A01</strong><span>D4U-NFCA01 系列</span></li><li><strong>B01</strong><span>D4U-NFCB01 系列</span></li></ul>
            <p>设备支持的具体功能取决于硬件版本与固件能力。</p>
          </section>
          <section class="info-block info-storage">
            <h2>数据说明</h2>
            <p>图片保存在浏览器 IndexedDB 中，队列与设置保存在 localStorage 中。换浏览器或清除站点数据后，这些内容不会保留。</p>
            <p>卡片操作以设备和固件支持为准。连接状态只表示读卡器已连接，不代表所有卡片功能均可用。</p>
          </section>
        </div>
      </div>
    </main>
  </div>
</template>

<style scoped>
.info-content { flex: 1; min-height: 0; overflow: auto; display: grid; grid-template-columns: 1fr 1.45fr; gap: clamp(28px,5vw,80px); padding: 22px 0 8px; }
.info-label { display: inline-flex; align-items: center; gap: 8px; font-size: 11px; color: var(--ink-70); }
.info-label img { width: 24px; height: 24px; border-radius: 7px; object-fit: cover; }
h1 { font-size: clamp(30px,3.3vw,48px); line-height: 1.3; font-weight: 400; letter-spacing: -1.5px; margin: 26px 0; }
.info-intro > p { font-size: 13px; line-height: 1.9; color: var(--ink-70); }
.project-links { margin-top: 18px; overflow-wrap: anywhere; }
.info-status { margin-top: 36px; display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
.info-status > span { font-size: 11px; color: var(--ink-45); }
.info-details { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; align-content: start; }
.info-block { padding: 22px; border-radius: 18px; }
.info-start { grid-column: 1 / -1; background: #eaf0ed; }
.info-environment { background: #edf0f7; }.info-storage { background: #f5ede6; }
.info-version { background: #f1efe7; }.info-devices { background: #eaf0ed; }
h2 { font-size: 13px; font-weight: 500; margin: 0 0 18px; }
ol { list-style: decimal-leading-zero; padding-left: 24px; margin: 0; }
li { padding-left: 8px; font-size: 12px; }li + li { margin-top: 16px; }li::marker { color: #7d9186; font-size: 10px; }
a { color: var(--ink); text-decoration: none; }a:hover { text-decoration: underline; text-underline-offset: 3px; }
p { font-size: 11px; line-height: 1.8; color: var(--ink-70); margin: 7px 0 0; }
dl { margin: 0 0 14px; font-size: 11px; }dl div + div { margin-top: 12px; }dt { color: var(--ink-45); }dd { margin: 3px 0 0; }
ul { list-style: none; margin: 0; padding: 0; font-size: 11px; }ul li { display: flex; align-items: baseline; gap: 10px; }ul li + li { margin-top: 10px; }ul strong { min-width: 34px; }ul span { color: var(--ink-70); }
@media (max-width: 1100px) { .info-content { grid-template-columns: .8fr 1.4fr; gap: 24px; }.info-block { padding: 16px; } }
@media (max-height: 760px) { .info-content { padding-top: 8px; }.info-block { padding: 16px; }h1 { margin: 20px 0; } }
</style>
