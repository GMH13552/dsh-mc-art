// 生成物：由 panel/build.mjs 从 tools/mcart-plugin/vanilla-parents.json 生成 —— 勿手改。
// 改表请改那份 JSON，然后 node panel/build.mjs（verify-build 会红着挡住漂移）。
// 来源：Minecraft 1.18.2 原版 jar 里 block/*.json 的父模型链（block → cube → cube_all / cube_column / cube_bottom_top；cross 独立无父）。数值照抄 jar，不做简化。
// 条目：7 个（block/block, block/cube, block/cube_all, block/cube_column, block/cube_bottom_top, block/cross, block/tinted_cross）
const VANILLA_PARENTS = {
  "block/block": {
    "textures": {},
    "gui_light": "side",
    "display": {
      "gui": {
        "rotation": [
          30,
          225,
          0
        ],
        "translation": [
          0,
          0,
          0
        ],
        "scale": [
          0.625,
          0.625,
          0.625
        ]
      }
    }
  },
  "block/cube": {
    "parent": "block/block",
    "textures": {
      "particle": "#north"
    },
    "elements": [
      {
        "from": [
          0,
          0,
          0
        ],
        "to": [
          16,
          16,
          16
        ],
        "faces": {
          "down": {
            "texture": "#down",
            "uv": [
              0,
              0,
              16,
              16
            ]
          },
          "up": {
            "texture": "#up",
            "uv": [
              0,
              0,
              16,
              16
            ]
          },
          "north": {
            "texture": "#north",
            "uv": [
              0,
              0,
              16,
              16
            ]
          },
          "south": {
            "texture": "#south",
            "uv": [
              0,
              0,
              16,
              16
            ]
          },
          "west": {
            "texture": "#west",
            "uv": [
              0,
              0,
              16,
              16
            ]
          },
          "east": {
            "texture": "#east",
            "uv": [
              0,
              0,
              16,
              16
            ]
          }
        }
      }
    ]
  },
  "block/cube_all": {
    "parent": "block/cube",
    "textures": {
      "particle": "#all",
      "down": "#all",
      "up": "#all",
      "north": "#all",
      "south": "#all",
      "west": "#all",
      "east": "#all"
    }
  },
  "block/cube_column": {
    "parent": "block/cube",
    "textures": {
      "particle": "#side",
      "end": "#end",
      "side": "#side",
      "down": "#end",
      "up": "#end",
      "north": "#side",
      "south": "#side",
      "west": "#side",
      "east": "#side"
    }
  },
  "block/cube_bottom_top": {
    "parent": "block/cube",
    "textures": {
      "particle": "#side",
      "bottom": "#bottom",
      "top": "#top",
      "side": "#side",
      "down": "#bottom",
      "up": "#top",
      "north": "#side",
      "south": "#side",
      "west": "#side",
      "east": "#side"
    }
  },
  "block/cross": {
    "textures": {
      "particle": "#cross"
    },
    "elements": [
      {
        "from": [
          0.8,
          0,
          8
        ],
        "to": [
          15.2,
          16,
          8
        ],
        "rotation": {
          "origin": [
            8,
            8,
            8
          ],
          "axis": "y",
          "angle": 45,
          "rescale": true
        },
        "shade": false,
        "faces": {
          "north": {
            "uv": [
              0,
              0,
              16,
              16
            ],
            "texture": "#cross"
          },
          "south": {
            "uv": [
              0,
              0,
              16,
              16
            ],
            "texture": "#cross"
          }
        }
      },
      {
        "from": [
          8,
          0,
          0.8
        ],
        "to": [
          8,
          16,
          15.2
        ],
        "rotation": {
          "origin": [
            8,
            8,
            8
          ],
          "axis": "y",
          "angle": 45,
          "rescale": true
        },
        "shade": false,
        "faces": {
          "west": {
            "uv": [
              0,
              0,
              16,
              16
            ],
            "texture": "#cross"
          },
          "east": {
            "uv": [
              0,
              0,
              16,
              16
            ],
            "texture": "#cross"
          }
        }
      }
    ]
  },
  "block/tinted_cross": {
    "parent": "block/cross",
    "textures": {}
  }
}
