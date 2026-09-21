# 铸文 LongCat 网关

封闭测试阶段监听 `0.0.0.0:8100`，不占用服务器上已有项目的端口。正式商用应通过独立域名和 HTTPS 反向代理对外开放，并关闭公网 8100 端口。

需要在服务器 `/etc/zhuwen-longcat.env` 配置：

```env
ZHUWEN_LONGCAT_API_KEY=在 LongCat 平台生成的 API Key
ZHUWEN_CLIENT_TOKEN=铸文客户端网关令牌
ZHUWEN_LONGCAT_MODEL=LongCat-2.0
ZHUWEN_MAX_CONTEXT_CHARS=300000
ZHUWEN_MAX_OUTPUT_TOKENS=20000
```

不要把真实 Key 提交到 Git 或写进安装包。客户端的网关令牌仅用于早期封闭测试；正式商用应替换为账号/激活码级别的授权令牌和用量计费。
