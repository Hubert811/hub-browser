#!/usr/bin/env bash
# A 阶段（chrome 外观改造）补丁：把 BrowserOS neo 的 chrome 改成 Dia 设计语言。
#
# 分步（配色依据 = docs/specs/dia-sidebar-tokens.md，逐像素复核过）：
#   colors   —— 颜色 mixer：纯白卡片 + 半透明标签 + 暖黑墨色
#   gradient —— 侧栏/窗口底的垂直渐变（ThemedBackground，kFrameTheme）
#   corners  —— 圆角（窗口/卡片 18，侧栏标签 10）
#   tabshadow —— 已废弃（无效，见 §8.9；保留仅为可撤销历史）
#   （后续：card 卡片分层 / shadows 光影）
#
# 用法：bash appearance-patch.sh colors          # 打颜色补丁
#       bash appearance-patch.sh colors --revert # 撤销
set -euo pipefail

SRC="${SRC:-/Volumes/SN850X_2T/hub-browser/src}"
COLOR_DIR="$SRC/chrome/browser/ui/color"
BUILD_GN="$COLOR_DIR/BUILD.gn"
MIXERS_CC="$COLOR_DIR/chrome_color_mixers.cc"
NEW_H="$COLOR_DIR/browserclaw_color_mixer.h"
NEW_CC="$COLOR_DIR/browserclaw_color_mixer.cc"
LAYOUT_CC="$SRC/chrome/browser/ui/layout_constants.cc"
TAB_H="$SRC/chrome/browser/ui/views/tabs/common/tab_view.h"
TAB_CC="$SRC/chrome/browser/ui/views/tabs/common/tab_view.cc"
THEMED_CC="$SRC/chrome/browser/ui/views/frame/themed_background.cc"
TABBED_LAYOUT_CC="$SRC/chrome/browser/ui/views/frame/layout/browser_view_tabbed_layout_impl.cc"

STEP="${1:-}"
REVERT=0
[ "${2:-}" = "--revert" ] && REVERT=1

case "$STEP" in
  colors|corners|gradient|card|tabshadow) ;;
  *) echo "用法: $0 colors|corners|gradient|card|tabshadow [--revert]" >&2; exit 2 ;;
esac

for f in "$BUILD_GN" "$MIXERS_CC"; do
  [ -f "$f" ] || { echo "✗ 找不到 $f" >&2; exit 1; }
done

# ---------------------------------------------------------------------------
# card —— A4 卡片分层：右侧整块（工具栏+书签栏+提示条+网页）作为一张浮在
# 底色上的卡片，边距 左4 / 右10 / 下10 / 上0（space-ui-and-model.md §1.7b）。
#
# 落点：BrowserViewTabbedLayoutImpl::CalculateProposedLayout() 里、竖排标签条
# 刚布局完并 `params.InsetHorizontal(tab_strip_width, leading)` 之后 —— 那一刻
# params.visual_client_area 正好等于「标签条右侧的整块区域」，也就是卡片的外框。
# 在这里 inset 一次，之后布局的工具栏/书签栏/提示条/网页**全部**自动落进卡片；
# 而竖排标签条是用更早算好的 vertical_tab_strip_bounds 添加的，**不受影响**
# （它就是底色本身，必须保持全高）。
#
# 条件与 ConfigureTopContainerBackground() 里画卡片圆角的条件保持一致：
# 竖排标签条 + 窗口非最大化/全屏。
# ---------------------------------------------------------------------------
card_edit() {   # $1 = apply|revert
  python3 - "$TABBED_LAYOUT_CC" "$1" <<'PYEOF'
import sys
path, mode = sys.argv[1], sys.argv[2]

# ---- (1) 卡片边距：工具栏/书签栏/提示条/网页整体收进卡片 ----------------
ANCHOR1 = '''      } else {
        unclipped_contents_region.Inset(gfx::Insets::TLBR(
            0, horizontal_layout.vertical_tab_strip_width, 0, 0));
      }
    }
'''

REPL1 = '''      } else {
        unclipped_contents_region.Inset(gfx::Insets::TLBR(
            0, horizontal_layout.vertical_tab_strip_width, 0, 0));
      }

      // BrowserClaw (Dia): the right-hand side is one card floating on the
      // frame base, not a full-bleed surface. Inset everything laid out below
      // -- toolbar, bookmarks bar, infobar and the web contents -- so the base
      // shows through. The vertical tab strip above is deliberately *not*
      // inset: it is the base. Same conditions as the rounded card corners in
      // ConfigureTopContainerBackground().
      //
      // Insets measured off Dia's live window (docs/specs/dia-sidebar-tokens.md
      // 8): top 6 / right 6 / bottom 6, and **0 on the leading edge** -- Dia's
      // card is flush against the sidebar and reads as "paper laid on it"
      // purely through its rounded top leading corner.
      if (layout_data_->window_state == WindowState::kNormal) {
        const gfx::Insets browserclaw_card_insets =
            gfx::Insets::TLBR(6, 0, 6, 6);
        params.Inset(browserclaw_card_insets);
        unclipped_contents_region.Inset(browserclaw_card_insets);
      }
    }
'''

# ---- (2) 左上角圆角：卡片已与标签条脱开，是浮起的卡片角 ----------------
ANCHOR2 = '''    const bool vertical_tab_strip_reaches_top =
        GetVerticalTabStripCollapsedState() !=
            VerticalTabStripCollapsedState::kCollapsed ||
        params.leading_exclusion.IsEmpty();
    if (!vertical_tab_strip_reaches_top) {
      corners[CornerOrientation::kTopLeading] =
          background->GetWindowCorner(/*upper=*/true);
    }
'''

REPL2 = '''    const bool vertical_tab_strip_reaches_top =
        GetVerticalTabStripCollapsedState() !=
            VerticalTabStripCollapsedState::kCollapsed ||
        params.leading_exclusion.IsEmpty();
    // BrowserClaw (Dia): upstream leaves this corner square when the tab strip
    // reaches the top, because the card is flush against it. Our card is inset
    // by 4px (see CalculateProposedLayout), so the top leading corner is a
    // floating card corner and has to be rounded like the trailing one.
    if (!vertical_tab_strip_reaches_top ||
        layout_data_->window_state == WindowState::kNormal) {
      corners[CornerOrientation::kTopLeading] =
          background->GetWindowCorner(/*upper=*/true);
    }
'''

# ---- (3) 底部两个圆角：卡片左右下三面都浮在底色上 ----------------
ANCHOR3 = '''    views().multi_contents_view->SetBackgroundRadii(content_corners);
  }
'''

REPL3 = '''    views().multi_contents_view->SetBackgroundRadii(content_corners);
  }

  // BrowserClaw (Dia): the card floats on the base along its left, right and
  // bottom edges, so both lower corners are rounded. Upstream only rounds the
  // leading one, and only when the glass frame is enabled. Placed after the
  // glass-frame block so it wins; SetBackgroundRadii() early-returns on an
  // unchanged value.
  if (layout_data_->tab_strip_type == TabStripType::kVertical &&
      layout_data_->window_state == WindowState::kNormal) {
    const int browserclaw_card_radius =
        GetLayoutConstant(LayoutConstant::kMainBackgroundRegionCornerRadius);
    gfx::RoundedCornersF browserclaw_card_corners;
    browserclaw_card_corners.set_lower_left(browserclaw_card_radius);
    browserclaw_card_corners.set_lower_right(browserclaw_card_radius);
    views().multi_contents_view->SetBackgroundRadii(browserclaw_card_corners);
  }
'''

# ---- (4) 工具栏左上角圆角：真正画卡片顶部的是工具栏，不是 top container ----
#
# ⚠️ 这是实测踩出来的：`ConfigureTopContainerBackground()` 设的圆角被**工具栏自己的
# CustomCornersBackground 盖住了** —— 工具栏是不透明的，且是 top container 的子视图，
# 它画在 top container 之上。竖排分支里上游只圆了 trailing 角，所以卡片左上角看起来是直角。
ANCHOR4 = '''    case TabStripType::kVertical: {
      // Curve trailing corner when it becomes the top trailing corner of the
      // browser.
      if (layout_data_->window_state == WindowState::kNormal &&
          IsParentedTo(views().top_container, views().browser_view) &&
          params.trailing_exclusion.IsEmpty()) {
        toolbar_corners[CornerOrientation::kTopTrailing] =
            toolbar_background->GetWindowCorner(/*upper=*/true);
      }
      break;
    }
'''

REPL4 = '''    case TabStripType::kVertical: {
      // Curve trailing corner when it becomes the top trailing corner of the
      // browser.
      if (layout_data_->window_state == WindowState::kNormal &&
          IsParentedTo(views().top_container, views().browser_view) &&
          params.trailing_exclusion.IsEmpty()) {
        toolbar_corners[CornerOrientation::kTopTrailing] =
            toolbar_background->GetWindowCorner(/*upper=*/true);
        // BrowserClaw (Dia): the card is inset from the tab strip (see
        // CalculateProposedLayout), so its top leading corner is a floating
        // card corner too. The toolbar is what actually paints the top of the
        // card -- it is opaque and sits on top of the top container -- so
        // rounding the top container alone is not enough.
        toolbar_corners[CornerOrientation::kTopLeading] =
            toolbar_background->GetWindowCorner(/*upper=*/true);
      }
      break;
    }
'''

EDITS = [(ANCHOR1, REPL1), (ANCHOR2, REPL2), (ANCHOR3, REPL3), (ANCHOR4, REPL4)]

with open(path) as f:
    src = f.read()

n = 0
for a, b in EDITS:
    if mode == 'apply':
        if b in src:
            continue
        if a not in src:
            print("✗ 锚点找不到: " + repr(a[:60]), file=sys.stderr)
            sys.exit(1)
        src = src.replace(a, b, 1)
    else:
        if b not in src:
            continue
        src = src.replace(b, a, 1)
    n += 1

with open(path, 'w') as f:
    f.write(src)
print("  %d 处已%s" % (n, "应用" if mode == 'apply' else "还原"))
PYEOF
}

# ---------------------------------------------------------------------------
# gradient —— 侧栏/窗口底的 Dia 垂直渐变
#
# 落点：ThemedBackground::PaintBackground()，全仓唯一绘制「窗口/侧栏底」的漏斗
# （唯一调用链 CustomCornersBackground::Paint -> CustomCorners::PaintPath ->
#  PaintBackground，ThemeChoice::kFrameTheme）。平色来自 ui::kColorFrameActive，
# 而 ui::ColorMixer 产不出渐变 ⇒ 只能在这里用 Skia 画。
#
# 锚定在 BrowserView 坐标系（和 PaintThemeAlignedImage 同一套对齐手法），
# 这样无论哪个子视图画其中一块底，整窗都是同一条连续渐变。
# ---------------------------------------------------------------------------
gradient_edit() {   # $1 = apply|revert
  python3 - "$THEMED_CC" "$1" <<'PYEOF'
import sys
path, mode = sys.argv[1], sys.argv[2]

INC_A = '#include "ui/gfx/canvas.h"\n'
INC_B = ('#include "ui/gfx/canvas.h"\n'
         '#include "ui/gfx/scoped_canvas.h"\n'
         '#include "ui/gfx/skia_paint_util.h"\n')
# 渐变端点常量在 mixer 头里；插在 chrome_color_id.h 之后以保持 include 字母序。
COLOR_ID_INC = '#include "chrome/browser/ui/color/chrome_color_id.h"\n'
MIXER_INC = '#include "chrome/browser/ui/color/browserclaw_color_mixer.h"\n'

NS_A = '}  // namespace\n\nThemedBackground::ThemedBackground('
NS_B = ('''// BrowserClaw (Dia): the window/sidebar base is a linear vertical gradient,
// not a flat colour (measured from Dia's live window; see
// docs/specs/dia-sidebar-tokens.md 1). Anchored in BrowserView coordinates --
// the same alignment trick PaintThemeAlignedImage uses -- so that every view
// painting a piece of the base yields one continuous window-wide gradient.
bool PaintBrowserClawFrameGradient(gfx::Canvas* canvas,
                                   const views::View* view,
                                   const BrowserView* browser_view) {
  const int height = browser_view->height();
  if (height <= 0 || browser_view->width() <= 0) {
    return false;
  }

  gfx::Point origin;
  views::View::ConvertPointToTarget(view, browser_view, &origin);

  gfx::ScopedCanvas scoped(canvas);
  canvas->Translate(gfx::Vector2d(-origin.x(), -origin.y()));

  cc::PaintFlags flags;
  flags.setAntiAlias(false);
  flags.setShader(gfx::CreateGradientShader(
      gfx::Point(0, 0), gfx::Point(0, height), browserclaw::kFrameGradientTop,
      browserclaw::kFrameGradientBottom));
  canvas->DrawRect(
      gfx::RectF(0, 0, browser_view->width(), height), flags);
  return true;
}

}  // namespace

ThemedBackground::ThemedBackground(''')

PAINT_A = '''  bool painted =
      PaintThemeCustomImage(canvas, view, browser_view, theme_choice);
  if (!painted) {
    canvas->DrawColor(view->GetColorProvider()->GetColor(
        GetThemeChoiceInfo(theme_choice, view).second));
  }
'''
PAINT_B = '''  bool painted =
      PaintThemeCustomImage(canvas, view, browser_view, theme_choice);
  if (painted) {
    return;
  }

  // BrowserClaw (Dia): the frame/sidebar base is a gradient, not a flat colour.
  if (theme_choice == ThemeChoice::kFrameTheme &&
      PaintBrowserClawFrameGradient(canvas, view, browser_view)) {
    return;
  }

  canvas->DrawColor(view->GetColorProvider()->GetColor(
      GetThemeChoiceInfo(theme_choice, view).second));
'''

INC_MARK = '#include "chrome/browser/ui/color/browserclaw_color_mixer.h"\n'

def edit(a, b):
    with open(path) as f:
        src = f.read()
    if mode == 'apply':
        if b in src:
            return 0
        if a not in src:
            raise SystemExit("锚点找不到: " + repr(a[:60]))
        src = src.replace(a, b, 1)
    else:
        if b not in src:
            return 0
        src = src.replace(b, a, 1)
    with open(path, 'w') as f:
        f.write(src)
    return 1

n = 0
n += edit(INC_A, INC_B)
n += edit(COLOR_ID_INC, MIXER_INC + COLOR_ID_INC)
n += edit(NS_A, NS_B)
n += edit(PAINT_A, PAINT_B)
print("  %d 处已%s" % (n, "应用" if mode == 'apply' else "还原"))
PYEOF
}

tabshadow_edit() {   # $1 = apply|revert
  python3 - "$TAB_H" "$TAB_CC" "$1" <<'PYEOF'
import sys
tab_h, tab_cc, mode = sys.argv[1], sys.argv[2], sys.argv[3]

INC_A = '#include "ui/views/view_observer.h"\n'
INC_B = ('#include "ui/views/view_observer.h"\n'
         '#include "ui/views/view_shadow.h"\n')
INC_C_A = '#include "ui/views/view_utils.h"\n'
INC_C_B = ('#include "ui/views/view_shadow.h"\n'
           '#include "ui/views/view_utils.h"\n')

MEM_A = '  bool active_ = false;\n'
MEM_B = ('  bool active_ = false;\n'
         '\n'
         '  // BrowserClaw (Dia): soft shadow under the selected tab.\n'
         '  std::unique_ptr<views::ViewShadow> browserclaw_active_shadow_;\n')

CC_A = ('  UpdateBorder();\n'
        '\n'
        '  // TODO(crbug.com/465159185): Update focus ring colors.\n'
        '  SchedulePaint();\n')
CC_B = ('  UpdateBorder();\n'
        '\n'
        '  // BrowserClaw (Dia): the selected tab carries a soft shadow.\n'
        '  if (IsActive()) {\n'
        '    if (!browserclaw_active_shadow_) {\n'
        '      browserclaw_active_shadow_ =\n'
        '          std::make_unique<views::ViewShadow>(this, /*elevation=*/2);\n'
        '      browserclaw_active_shadow_->SetRoundedCornerRadius(\n'
        '          static_cast<int>(GetCornerRadius()));\n'
        '    }\n'
        '  } else {\n'
        '    browserclaw_active_shadow_.reset();\n'
        '  }\n'
        '\n'
        '  // TODO(crbug.com/465159185): Update focus ring colors.\n'
        '  SchedulePaint();\n')


def edit(path, a, b):
    with open(path) as f:
        src = f.read()
    if mode == 'apply':
        if b in src:
            return 0
        if a not in src:
            raise SystemExit("锚点找不到: " + path)
        src = src.replace(a, b, 1)
    else:
        if b not in src:
            return 0
        src = src.replace(b, a, 1)
    with open(path, 'w') as f:
        f.write(src)
    return 1


n = 0
n += edit(tab_h, INC_A, INC_B)
n += edit(tab_h, MEM_A, MEM_B)
n += edit(tab_cc, INC_C_A, INC_C_B)
n += edit(tab_cc, CC_A, CC_B)
print("  %d 处已%s" % (n, "应用" if mode == 'apply' else "还原"))
PYEOF
}

if [ "$REVERT" = "1" ]; then
  echo "→ 撤销 $STEP 补丁"
  if [ "$STEP" = "tabshadow" ]; then
    tabshadow_edit revert
    echo "✓ 已撤销（未重编）"
    exit 0
  fi
  if [ "$STEP" = "gradient" ]; then
    gradient_edit revert
    echo "✓ 已撤销（未重编）"
    exit 0
  fi
  if [ "$STEP" = "card" ]; then
    card_edit revert
    echo "✓ 已撤销（未重编）"
    exit 0
  fi
  if [ "$STEP" = "corners" ]; then
    python3 - "$LAYOUT_CC" revert <<'PYEOF'
import sys
path = sys.argv[1]
ANCHOR = """    case LayoutConstant::kMainBackgroundRegionCornerRadius:
    case LayoutConstant::kToolbarCornerRadius:
    case LayoutConstant::kVerticalTabCornerRadius:
      return 8;
"""
REPL = """    case LayoutConstant::kMainBackgroundRegionCornerRadius:
    case LayoutConstant::kToolbarCornerRadius:
      // BrowserClaw (Dia): window / card radius 18
      return 18;
    case LayoutConstant::kVerticalTabCornerRadius:
      // BrowserClaw (Dia): sidebar tab matches the + button radius (10)
      return 10;
"""
with open(path) as f:
    src = f.read()
if REPL not in src:
    print("  未打过，跳过")
    sys.exit(0)
with open(path, "w") as f:
    f.write(src.replace(REPL, ANCHOR, 1))
print("  layout_constants.cc 已还原")
PYEOF
    echo "✓ 已撤销（未重编）"
    exit 0
  fi
  rm -f "$NEW_CC" "$NEW_H"
  python3 - "$BUILD_GN" "$MIXERS_CC" <<'PY'
import sys
build_gn, mixers = sys.argv[1], sys.argv[2]

def drop_lines(path, pred):
    with open(path) as f:
        lines = f.readlines()
    kept = [l for l in lines if not pred(l)]
    if len(kept) != len(lines):
        with open(path, 'w') as f:
            f.writelines(kept)
    return len(lines) - len(kept)

n1 = drop_lines(build_gn, lambda l: 'browserclaw_color_mixer' in l)
# 我插入的每一行都带 browserclaw / BrowserClaw marker，按行删即等价精确还原
n2 = drop_lines(mixers, lambda l: ('browserclaw' in l) or ('BrowserClaw' in l))
print(f"  BUILD.gn -{n1} 行, chrome_color_mixers.cc -{n2} 行")
PY
  echo "✓ 已撤销（未重编）"
  exit 0
fi

if [ "$STEP" = "tabshadow" ]; then
  echo "→ 改 tab_view.{h,cc}（选中标签加柔和投影）"
  tabshadow_edit apply
  echo
  echo "✓ tabshadow 补丁已打入：修改 chrome/browser/ui/views/tabs/common/tab_view.{h,cc}"
  exit 0
fi

if [ "$STEP" = "gradient" ]; then
  echo "→ 改 themed_background.cc（窗口/侧栏底改成 Dia 垂直渐变）"
  gradient_edit apply
  echo
  echo "✓ gradient 补丁已打入：修改 chrome/browser/ui/views/frame/themed_background.cc"
  echo "  ⚠️ 依赖 colors 步骤（渐变端点常量在 browserclaw_color_mixer.h 里）"
  exit 0
fi

if [ "$STEP" = "card" ]; then
  echo "→ 改 browser_view_tabbed_layout_impl.cc（右侧整块收成卡片，左4/右10/下10/上0）"
  card_edit apply
  echo
  echo "✓ card 补丁已打入：修改 chrome/browser/ui/views/frame/layout/browser_view_tabbed_layout_impl.cc"
  echo "  这是 A 阶段唯一侵入 Chromium 布局的一步，也是上游同步冲突的主要来源"
  exit 0
fi

if [ "$STEP" = "corners" ]; then
  echo "→ 改 layout_constants.cc（窗口/卡片圆角 8 → 18；侧栏标签 → 药丸 15）"
  python3 - "$LAYOUT_CC" <<'PYEOF'
import sys
path = sys.argv[1]
ANCHOR = """    case LayoutConstant::kMainBackgroundRegionCornerRadius:
    case LayoutConstant::kToolbarCornerRadius:
    case LayoutConstant::kVerticalTabCornerRadius:
      return 8;
"""
REPL = """    case LayoutConstant::kMainBackgroundRegionCornerRadius:
    case LayoutConstant::kToolbarCornerRadius:
      // BrowserClaw (Dia): window / card radius 18
      return 18;
    case LayoutConstant::kVerticalTabCornerRadius:
      // BrowserClaw (Dia): sidebar tab matches the + button radius (10)
      return 10;
"""
with open(path) as f:
    src = f.read()
if "BrowserClaw (Dia)" in src:
    print("  已存在，跳过")
    sys.exit(0)
if ANCHOR not in src:
    print("✗ layout_constants.cc 锚点找不到", file=sys.stderr)
    sys.exit(1)
with open(path, "w") as f:
    f.write(src.replace(ANCHOR, REPL, 1))
print("  +5 行")
PYEOF
  echo
  echo "✓ corners 补丁已打入：修改 chrome/browser/ui/layout_constants.cc"
  exit 0
fi

echo "→ 写入 $NEW_CC / $NEW_H"
cat > "$NEW_H" <<'EOF'
// Copyright 2026 The Chromium Authors
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

#ifndef CHROME_BROWSER_UI_COLOR_BROWSERCLAW_COLOR_MIXER_H_
#define CHROME_BROWSER_UI_COLOR_BROWSERCLAW_COLOR_MIXER_H_

#include "third_party/skia/include/core/SkColor.h"
#include "ui/color/color_provider_key.h"

namespace ui {
class ColorProvider;
}  // namespace ui

namespace browserclaw {

// The Dia sidebar/window base is a *linear vertical gradient*, not a flat
// colour (measured on Dia's live window; docs/specs/dia-sidebar-tokens.md 1).
// ThemedBackground paints it for ThemeChoice::kFrameTheme. Exported here so the
// gradient endpoints and the flat ui::kColorFrameActive fallback stay in sync.
inline constexpr SkColor kFrameGradientTop = SkColorSetRGB(0xEF, 0xE3, 0xC9);
inline constexpr SkColor kFrameGradientMid = SkColorSetRGB(0xF4, 0xED, 0xDF);
inline constexpr SkColor kFrameGradientBottom =
    SkColorSetRGB(0xF9, 0xF7, 0xF4);

// Applies the Dia palette (docs/specs/dia-sidebar-tokens.md): pure-white card,
// translucent tab pills that let the sidebar gradient through, warm ink.
// Registered last among the built-in chrome mixers so it wins.
void AddBrowserClawColorMixer(ui::ColorProvider* provider,
                              const ui::ColorProviderKey& key);

}  // namespace browserclaw

#endif  // CHROME_BROWSER_UI_COLOR_BROWSERCLAW_COLOR_MIXER_H_
EOF

cat > "$NEW_CC" <<'EOF'
// Copyright 2026 The Chromium Authors
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

#include "chrome/browser/ui/color/browserclaw_color_mixer.h"

#include "chrome/browser/ui/color/chrome_color_id.h"
#include "third_party/skia/include/core/SkColor.h"
#include "ui/color/color_id.h"
#include "ui/color/color_mixer.h"
#include "ui/color/color_provider.h"
#include "ui/color/color_recipe.h"

namespace browserclaw {
namespace {

// Dia tokens (docs/specs/space-ui-and-model.md 1.7). Only the *surfaces* are
// re-tinted here; state colours (run blue / attention yellow / alert red) stay
// on the ego values on purpose (decision D13).
constexpr SkColor kCream = SkColorSetRGB(0xF7, 0xF1, 0xE4);  // 侧栏 / 窗口底
constexpr SkColor kPaper = SkColorSetRGB(0xFB, 0xF9, 0xF5);  // 右侧卡片
constexpr SkColor kInk = SkColorSetRGB(0x1F, 0x1D, 0x19);    // 暖黑
constexpr SkColor kInk2 = SkColorSetRGB(0x6B, 0x64, 0x59);   // 暖灰

}  // namespace

void AddBrowserClawColorMixer(ui::ColorProvider* provider,
                              const ui::ColorProviderKey& key) {
  ui::ColorMixer& mixer = provider->AddMixer();

  // 底层 = 窗口 + 侧栏（侧栏用的是 FrameTheme ⇒ ui::kColorFrameActive/Inactive）
  mixer[ui::kColorFrameActive] = {kCream};
  mixer[ui::kColorFrameInactive] = {kCream};

  // 上层 = 右侧整块卡片（工具栏 / 书签栏 / 内容底，用 ToolbarTheme）
  mixer[chrome::kColorToolbar] = {kPaper};
  mixer[chrome::kColorBookmarkBarBackground] = {kPaper};
  mixer[chrome::kColorNewTabPageBackground] = {kPaper};

  // 暖灰阶文字（工具栏 / 书签栏）
  mixer[chrome::kColorToolbarText] = {kInk};
  mixer[chrome::kColorToolbarTextDefault] = {kInk};
  mixer[chrome::kColorBookmarkBarForeground] = {kInk};

  // 侧栏标签文字（激活 / 未激活）
  mixer[chrome::kColorTabForegroundActiveFrameActive] = {kInk};
  mixer[chrome::kColorTabForegroundInactiveFrameActive] = {kInk2};
  mixer[chrome::kColorTabForegroundInactiveFrameInactive] = {kInk2};
}

}  // namespace browserclaw
EOF

echo "→ 改 BUILD.gn（mixers 目标加两个源文件）"
python3 - "$BUILD_GN" <<'PY'
import sys
path = sys.argv[1]
with open(path) as f:
    src = f.read()
if 'browserclaw_color_mixer' in src:
    print("  已存在，跳过")
    sys.exit(0)
anchor = '    "chrome_color_mixer.cc",\n'
if anchor not in src:
    print("✗ BUILD.gn 锚点找不到", file=sys.stderr)
    sys.exit(1)
add = ('    "browserclaw_color_mixer.cc",\n'
       '    "browserclaw_color_mixer.h",\n')
with open(path, 'w') as f:
    f.write(src.replace(anchor, anchor + add, 1))
print("  +2 行")
PY

echo "→ 改 chrome_color_mixers.cc（注册 BrowserClaw mixer，放在内置 mixer 最后）"
python3 - "$MIXERS_CC" <<'PY'
import sys
path = sys.argv[1]
with open(path) as f:
    src = f.read()
if 'browserclaw' in src:
    print("  已存在，跳过")
    sys.exit(0)

inc_anchor = '#include "chrome/browser/ui/color/chrome_color_mixer.h"\n'
inc_add = ('#include "chrome/browser/ui/color/browserclaw_color_mixer.h"\n')
if inc_anchor not in src:
    print("✗ include 锚点找不到", file=sys.stderr)
    sys.exit(1)
src = src.replace(inc_anchor, inc_add + inc_anchor, 1)

call_anchor = ('  // Must be the last one in order to override other mixer colors.\n'
               '  AddNativeChromeColorMixer(provider, key);\n')
call_add = ('  // Must be the last one in order to override other mixer colors.\n'
            '  AddNativeChromeColorMixer(provider, key);\n'
            '\n'
            '  // BrowserClaw (Dia) palette: overrides the surfaces above so the\n'
            '  // cream base / paper card split wins over the native mixers.\n'
            '  browserclaw::AddBrowserClawColorMixer(provider, key);\n')
if call_anchor not in src:
    print("✗ 调用点锚点找不到", file=sys.stderr)
    sys.exit(1)
src = src.replace(call_anchor, call_add, 1)

with open(path, 'w') as f:
    f.write(src)
print("  +5 行")
PY

echo
echo "✓ colors 补丁已打入："
echo "  新增  $NEW_CC"
echo "  新增  $NEW_H"
echo "  修改  chrome/browser/ui/color/BUILD.gn"
echo "  修改  chrome/browser/ui/color/chrome_color_mixers.cc"
