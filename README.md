# aerolink

实时航空/船舶数据桥：将 ADS-B、AIS、卫星等位置数据同步推送到 Cesium 3D 地图和 FlightGear 多人服务器。

## 文件结构

```
aerolink/
├── server.js       主服务：HTTP + WebSocket + FG MP 输出
├── czml.js         CZML 生成（位置时序、四元数、外推策略）
├── store.js        实体状态 + 历史轨迹累积
├── fgmp.js         FlightGear MP 协议：坐标变换、UDP 包构造
└── public/
    └── map3d.html  Cesium 3D 地图前端
```

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 放入 CesiumJS

从 https://cesium.com/downloads/ 下载 CesiumJS，将 `Build/Cesium` 目录复制到 `public/`：

```bash
cp -r /path/to/CesiumJS/Build/Cesium public/
```

### 3. 下载 3D 模型

模型来自 SDRangel 项目，解压后放入 `3d/` 目录即可被 aerolink 直接使用。

**3D 模型包**（glb 格式，包含飞机、船只、卫星等，各机型按 ICAO 代码命名）：

```
https://github.com/srcejon/sdrangel-3d-models/releases/latest/download/sdrangel3dmodels.zip
```

**涂装贴图**（Bluebell CSL 项目，版权归原作者，见 https://github.com/oktal3700/bluebell）：

| 包名 | 内容 | Google Drive |
|------|------|--------------|
| `bb_airbus_png.zip` | 空客系列 | `https://drive.google.com/uc?export=download&id=10fFhflgWXCu7hmd8wqNdXw1qHJ6ecz9Z` |
| `bb_boeing_png.zip` | 波音系列 | `https://drive.google.com/uc?export=download&id=1OA3pmAp5jqrjP7kRS1z_zNNyi_iLu9z_` |
| `bb_ga_png.zip` | 通用航空 | `https://drive.google.com/uc?export=download&id=1TZsvlLqT5x3KLkiqtN8LzAzoLxeYTA-1` |
| `bb_heli_png.zip` | 直升机 | `https://drive.google.com/uc?export=download&id=1qB2xDVHdooLeLKCPyVnVDDHRlhPVpUYs` |
| `bb_jets_png.zip` | 公务机/喷气 | `https://drive.google.com/uc?export=download&id=1v1fzTpyjjfcXyoT7vHjnyvuwqrSQzPrg` |
| `bb_mil_png.zip` | 军用机 | `https://drive.google.com/uc?export=download&id=1lI-2bAVVxhKvel7_suGVdkky4BQDQE9n` |
| `bb_props_png.zip` | 螺旋桨飞机 | `https://drive.google.com/uc?export=download&id=1fD8YxKsa9P_z2gL1aM97ZEN-HoI28SLE` |

> 涂装贴图版权归 Bluebell CSL 项目原作者所有，不得上传至其他站点。  
> 涂装 PNG 与 glb 模型配合使用，当前 aerolink 仅加载 glb，贴图留作后续 PBR 渲染扩展用。

**下载脚本**：

```bash
mkdir -p 3d

# 3D 模型包（必需）
curl -L https://github.com/srcejon/sdrangel-3d-models/releases/latest/download/sdrangel3dmodels.zip \
     -o /tmp/sdrangel3dmodels.zip
unzip /tmp/sdrangel3dmodels.zip -d 3d/

# 涂装贴图包（可选，用于 PBR 渲染）
declare -A BB_URLS=(
  [bb_airbus_png]="https://drive.google.com/uc?export=download&id=10fFhflgWXCu7hmd8wqNdXw1qHJ6ecz9Z"
  [bb_boeing_png]="https://drive.google.com/uc?export=download&id=1OA3pmAp5jqrjP7kRS1z_zNNyi_iLu9z_"
  [bb_ga_png]="https://drive.google.com/uc?export=download&id=1TZsvlLqT5x3KLkiqtN8LzAzoLxeYTA-1"
  [bb_heli_png]="https://drive.google.com/uc?export=download&id=1qB2xDVHdooLeLKCPyVnVDDHRlhPVpUYs"
  [bb_jets_png]="https://drive.google.com/uc?export=download&id=1v1fzTpyjjfcXyoT7vHjnyvuwqrSQzPrg"
  [bb_mil_png]="https://drive.google.com/uc?export=download&id=1lI-2bAVVxhKvel7_suGVdkky4BQDQE9n"
  [bb_props_png]="https://drive.google.com/uc?export=download&id=1fD8YxKsa9P_z2gL1aM97ZEN-HoI28SLE"
)
for name in "${!BB_URLS[@]}"; do
  curl -L "${BB_URLS[$name]}" -o "/tmp/${name}.zip"
  unzip "/tmp/${name}.zip" -d 3d/
done
```

### 4. 启动

```bash
# 只启动地图
node server.js

# 同时推送到 FlightGear
FG_HOST=192.168.1.50 node server.js

# 完整选项
PORT=8080 FG_HOST=localhost FG_PORT=5000 FG_HZ=2 \
FG_MODEL_MAP=models.json node server.js
```

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `8080` | HTTP/WebSocket 监听端口 |
| `MODELS_DIR` | `./3d` | glTF 模型目录 |
| `FG_HOST` | _(未设置)_ | fgms 主机，**不设则不推 FG** |
| `FG_PORT` | `5000` | fgms UDP 端口 |
| `FG_HZ` | `1` | FG 推送频率（包/秒） |
| `FG_MODEL_MAP` | _(内置)_ | 呼号前缀→FG 机型 JSON 文件 |

## REST API

```
POST   /item        推入/更新实体
DELETE /item/:id    删除实体
DELETE /items       清空所有
GET    /items       查询当前状态
GET    /            Cesium 地图
```

### 实体字段（POST /item）

| 字段 | 类型 | 说明 |
|------|------|------|
| `name` | string | 唯一 ID（必填） |
| `lat` / `lon` | number | 十进制度 |
| `alt` | number | 高度（米） |
| `positionDateTime` | ISO8601 | 位置时间戳 |
| `heading` | number | 航向（度，北为 0，顺时针） |
| `pitch` | number | 俯仰角（度） |
| `roll` | number | 翻滚角（度） |
| `useHeadingPitchRoll` | bool | true = 用显式 HPR；false = 速度推算 |
| `model` | string | glTF 文件名，从 `/3d/` 加载，如 `B738.glb` |
| `fixedPosition` | bool | 固定标注，不记录轨迹 |
| `extrapolateSecs` | number | Cesium 前向外推秒数（默认 60） |

## 示例：对接 dump1090 ADS-B

```bash
# 每秒推一次飞机位置
while true; do
  curl -s http://dump1090-host:8080/data/aircraft.json | python3 -c "
import sys, json, requests, datetime

data = json.load(sys.stdin)
now  = datetime.datetime.utcnow().isoformat() + 'Z'
for ac in data.get('aircraft', []):
    if 'lat' not in ac: continue
    requests.post('http://localhost:8080/item', json={
        'name':  ac['hex'].upper(),
        'lat':   ac['lat'],
        'lon':   ac['lon'],
        'alt':   ac.get('altitude', 0) * 0.3048,
        'positionDateTime': now,
        'label': (ac.get('flight') or ac['hex']).strip(),
        'heading': ac.get('track', 0),
        'useHeadingPitchRoll': True,
        'model':  'B738.glb',
        'extrapolateSecs': 30,
    })
  "
  sleep 1
done
```

## 模型来源与许可

| 资源 | 来源 | 许可 |
|------|------|------|
| 3D 模型（glb） | [srcejon/sdrangel-3d-models](https://github.com/srcejon/sdrangel-3d-models) | 各模型单独授权，见仓库 LICENSE |
| 涂装贴图（PNG） | [oktal3700/bluebell](https://github.com/oktal3700/bluebell) | 版权归原作者，不得再分发 |
| 原始 FG 模型 | [FGMEMBERS](https://github.com/FGMEMBERS) | GPL-2.0 |