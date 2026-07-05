# 多吃扇嘴巴子 · iPhone 本地版

可添加到 iPhone 主屏幕的离线饮食记录。食物、营养目标和历史记录都保存在手机的 IndexedDB 中，不需要后台服务器。

## 本地预览

需要 Node.js 18 或更高版本，无需安装第三方依赖。

```powershell
npm start
```

然后打开 `http://127.0.0.1:3000`。

同一 Wi-Fi 下可用手机访问 `http://电脑的局域网IP:3000` 预览。正式添加到主屏幕时，应将 `public` 目录部署到任意免费 HTTPS 静态网站托管。

## iPhone 使用

1. 用 Safari 打开部署地址。
2. 点击 Safari 的“分享”按钮。
3. 选择“添加到主屏幕”。

数据只存在当前 iPhone。请在“设置”中定期导出 JSON 备份；换机或清理浏览器数据前务必先备份。

## 检查

```powershell
npm test
```
