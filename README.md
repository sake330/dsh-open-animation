# dsh-open-animation

DSH 启动时先播一段自己的画面（视频或动图），播完淡出，界面露出来。自带一份可用的默认动画，也可以在设置页换成自己的文件。

## 装

```
plugin_manager action=install_bundle target=<本仓库绝对路径>
```

或命令行（需要先 `npm install -g @deepseek-ai/dsh`）：

```bash
dsh plugin --profile web add <本仓库绝对路径>
```

装完**重启 DSH**。卸载在 **设置 → 插件** 里做。

## 用

设置页在 **设置 → 插件 → 开屏动画**。

- **素材路径**：直接粘贴，或点「选择文件…」弹原生对话框（对话框在运行 DSH 的那台机器上弹，从别的机器访问浏览器就看不到它，手输路径永远可用）。中文路径没问题。
- **保存 / 清除 / 预览**：清除等于关掉开屏。预览放的是**已保存生效**的素材，想预览新路径先保存；预览会铺满窗口，右下角「结束预览」或按 `Esc` 退出。
- **播放选项**：静音、填充方式、退出方式、渐隐时长、最长播放时长。复选框和下拉框改完立即保存，数值框按回车或点到别处才保存。

开屏期间右下角默认有「跳过」按钮，`Esc`、空格、回车也可以提前退出。播放期间画面拥有输入，点击不会穿透到底下的应用。

## 播什么

三层按优先级决定，同一个「空路径」在不同层里含义不同：

| 层 | 谁写的 | 空着表示 |
|---|---|---|
| URL 参数 `?src=…` | 预览临时用 | 没有，写了就是它 |
| 保存的配置 `config.json` | 设置页 | **关掉**，不回退到默认动画 |
| 行配置 `config.src` | `cordis.patch.yml` | **没配**，这时才播默认动画 |

路径写了但找不到文件，结果同样是**不播**，原因会写在设置页的状态行里。

## 配置字段

改默认值就写 profile 的 `cordis.patch.yml`。**覆盖会替换整份 `config`**，没写的字段回到下表默认值：

```yaml
- id: dsh-open-animation
  name: dsh-open-animation
  config:
    fit: contain      # 完整显示，默认 cover 是铺满裁切
    muted: false      # 带声音
    fadeOutMs: 600    # 淡出 0.6 秒
    skip: click       # 点任意位置跳过
```

| 字段 | 默认 | 作用 |
|---|---|---|
| `src` | `''` | 素材路径，空 = 用自带动画 |
| `autoplay` | `true` | 是否自动播放 |
| `muted` | `true` | 静音。Chromium 会拦未交互页面上的带声音自动播放，所以默认静音 |
| `volume` | `0.6` | 音量，0–1 |
| `fit` | `cover` | `cover` 铺满裁切不拉伸 / `contain` 完整显示留边 / `fill` 拉伸填满 |
| `background` | `#000000` | 画面底色 |
| `fadeInMs` | `0` | 预留的出现淡入 |
| `fadeOutMs` | `300` | 播完后的淡出时长 |
| `holdAfterEndMs` | `0` | 播完到开始淡出之间的停顿 |
| `skip` | `button` | `button` 右下角按钮 / `click` 点任意位置 / `auto` 自动 / `never` 不可退出 |
| `skipAfterMs` | `1200` | 仅 `skip: auto` 生效 |
| `playbackRate` | `1` | 倍速，0.1–4 |
| `duration` | `0` | 最长播放毫秒数，`0` = 播到结束（自带动画自带 3200） |
| `maxReplays` | `0` | 重复播放次数 |
| `waitForAppMs` | `2500` | 宿主没给出时长时的兜底等待 |
| `coverBeforePaint` | `true` | 等界面渲染后再开始，避免先闪一下 |
| `fallbackRemoveMs` | `10000` | 开始播放前的兜底时限，到点撤掉覆盖层 |
| `trustedHosts` | `[]` | 额外信任的主机名，只有从非回环地址访问时才需要 |

字段填错（未知键、非法枚举）会让这一行**激活失败并在日志里报错**，不会静默退回默认值。

## 支持的格式

视频：`mp4`、`m4v`、`webm`、`mov`、`mkv`、`ogv`、`ogm`、`mpg`、`mpeg`、`ts`
动图和静态图：`gif`、`apng`、`webp`、`avif`、`png`、`jpg`、`jpeg`、`svg`、`bmp`、`ico`

推荐 **`webm`(VP9)** 或 **`mp4`(H.264)**，这两个所有平台都能播。`mov` 和 `mkv` 只是容器，里面的编码不支持就放不出来。转码：

```bash
ffmpeg -i input.mov -c:v libx264 -crf 20 -pix_fmt yuv420p -movflags +faststart -an opening.mp4
ffmpeg -i input.mov -c:v libvpx-vp9 -crf 32 -b:v 0 -an opening.webm
```

`-movflags +faststart` 把索引挪到文件开头，不用下完整个文件就能起播。

## 遇到问题时
设置页的状态行会说明当前会播什么、或者为什么不播。**有画面没声音**是因为 Chromium 要求先有用户交互才允许带声音播放，插件会自动静音重试。**启动时看到 DSH 自己的小鲸鱼**是 Electron 主窗口画的启动画面，插件替换不了，它负责的是之后那一段。

工程细节（路由与信任栅栏、Cordis 上下文的注意事项、测试套件）写在代码注释和 `tools/` 里。

## 许可

MIT，覆盖插件代码。`assets/opening.svg` 是自带的示例素材，同样以 MIT 提供，换成自己的覆盖它或改 `src` 即可。
