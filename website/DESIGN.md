---
name: Agents Can Communicate
description: A light, readable website for a small local programming helper.
colors:
  white: "#fff"
  paper: "#f5f6f5"
  ink: "#252925"
  muted: "#596159"
  accent: "#20623a"
  accent-hover: "#17482b"
  line: "#dce1dc"
  home-accent: "#0755ef"
  home-accent-hover: "#003dc0"
  home-ink: "#152032"
  home-muted: "#5d6575"
  home-line: "#e0e6f0"
  home-code: "#f8faff"
  home-code-line: "#d9e2f3"
  home-copy-hover: "#eaf0ff"
typography:
  display:
    fontFamily: '"Public Sans", sans-serif'
    fontSize: "46px"
    fontWeight: 650
    lineHeight: 1.13
    letterSpacing: "-.03em"
  display-tablet:
    fontFamily: '"Public Sans", sans-serif'
    fontSize: "39px"
    fontWeight: 650
    lineHeight: 1.13
    letterSpacing: "-.03em"
  display-mobile:
    fontFamily: '"Public Sans", sans-serif'
    fontSize: "34px"
    fontWeight: 650
    lineHeight: 1.15
    letterSpacing: "-.03em"
  headline:
    fontFamily: '"Public Sans", sans-serif'
    fontSize: "22px"
    fontWeight: 600
    lineHeight: 1.35
    letterSpacing: "-.015em"
  body:
    fontFamily: '"Public Sans", sans-serif'
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.7
  home-body:
    fontFamily: '"Public Sans", sans-serif'
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.75
  home-description:
    fontFamily: '"Public Sans", sans-serif'
    fontSize: "18px"
    fontWeight: 400
    lineHeight: 1.6
  label:
    fontFamily: '"Public Sans", sans-serif'
    fontSize: "14px"
  code:
    fontFamily: 'ui-monospace, "SFMono-Regular", Consolas, monospace'
    fontSize: "13px"
    lineHeight: 1.75
  essay-body:
    fontFamily: "Georgia, serif"
    fontSize: "19px"
    fontWeight: 400
    lineHeight: 1.75
rounded:
  copy: "4px"
  control: "5px"
  search: "6px"
  home-action: "7px"
spacing:
  inline-small: "8px"
  copy-gap: "16px"
  control-inset: "20px"
  install-gap: "24px"
  section-large: "40px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.white}"
    rounded: "{rounded.control}"
    padding: "7px 15px"
  button-primary-hover:
    backgroundColor: "{colors.accent-hover}"
    textColor: "{colors.white}"
  button-home:
    backgroundColor: "{colors.home-accent}"
    textColor: "{colors.white}"
    rounded: "{rounded.home-action}"
    padding: "7px 20px"
  button-home-hover:
    backgroundColor: "{colors.home-accent-hover}"
    textColor: "{colors.white}"
  code-home:
    backgroundColor: "{colors.home-code}"
    textColor: "{colors.home-ink}"
    rounded: "{rounded.control}"
    typography: "{typography.code}"
    padding: "46px 20px 20px"
---

# Design System: Agents Can Communicate

## Overview

**Creative North Star: "A carefully made utility"**

A compact, readable project website for a small installed programming helper.
Public Sans, white space, ordinary links and light code surfaces support the
installation and reading tasks. The homepage opening adds one tactile paired-C
object beside its plain-language explanation.

This records the implemented homepage opening and preserves the incumbent
interior system. The opening was selected under delegated design decisions;
its finish-review disposition is `ship` at that bounded scope. This record
establishes neither user aesthetic approval nor a whole-site palette rollout.

**Key Characteristics:**

- Light-only surfaces and visible keyboard focus.
- Cobalt actions and a decorative blue/yellow object on the homepage.
- Green accents and six distinct reading families on interior pages.
- Flat interface surfaces, with depth confined to the raster object.

## Colors

The palette has two implemented scopes; frontmatter token values are normative.

### Primary

- **Home cobalt** (`home-accent`, `home-accent-hover`): homepage links, setup
  action, caret and focus. The darker value supplies hover feedback.
- **Interior green** (`accent`, `accent-hover`): links, actions, focus and current
  navigation on all other routes.

### Secondary

- **Sunny yellow** belongs to the shaded paired-C raster object. It is decorative
  material, with no extracted flat UI color token or yellow control variant.

### Neutral

- **White** is the page and navigation background throughout.
- **Home ink, muted and line** distinguish text, supporting text and rules.
- **Home code, code line and copy hover** keep installation light while separating
  the command surface and its copy control.
- **Ink, muted, paper and line** remain the interior text, supporting text,
  light code/table surfaces and dividers.

**The Scope Rule.** Apply homepage overrides only to the homepage; preserve the
interior palette until a separate change implements and reviews it.

## Typography

Self-hosted Public Sans serves interface text and headings; its loaded variable
weight range is 400–700. Georgia serves essay body text only. Commands use the
system monospace stack recorded above.

- **Display:** the homepage H1 uses `display`, `display-tablet` at widths up to
  1000px, and `display-mobile` up to 700px. Its maximum measure is 24ch.
- **Headline:** `headline` describes homepage section headings; use-link headings
  are 18px, and the introductory use label is muted at 16px.
- **Body:** `body` is the site baseline; homepage paragraphs use `home-body`
  with a 73ch maximum. The opening explanation uses `home-description` at 49ch,
  falling to 16px on mobile. Ordinary homepage body text becomes 15px there.
- **Labels and code:** navigation is 14px; supporting homepage notes are 13px.
  The install command uses `code`, reduced to 12px on mobile.
- **Reading families:** article titles vary by format, generally 30–40px;
  task/reference body text is 15–18px. Essay body starts at `essay-body`;
  its mobile body and introduction become 21px and 23px respectively.

## Layout

The homepage, its header and its footer share a maximum width of 1120px, with
32px side gutters. The opening uses a 1.15fr/1fr copy/object grid with a 20px gap;
up to 1000px it changes to 1.2fr/1fr with a 10px gap. At 700px it stacks, uses
20px side gutters, and puts the 245px-wide object above the copy. The three
unboxed use links become one column. Later homepage sections retain a 760px
reading measure; the opening and header use the wider shell.

Interior shells also reach 1120px. Preserve their distinct index structures:
a guide start/task list, client catalogue, comparison matrix, essay list,
engineering register and documentation workspace. Preserve the matching article
families: guide outline, setup sections, wide comparison tables, serif essay
reading, report provenance and reference navigation. Their reading rails,
columns and tables serve the material rather than reproducing the homepage.

Spacing is contextual: recurring 8px, 16px, 20px, 24px and 40px steps coexist
with measured gaps for specific layouts. Do not force every gap onto a new scale.

## Elevation & Depth

Interface surfaces are flat: no CSS box shadows appear in the sampled shared,
home, collection or article styles. Rules, light fills and spacing separate
content. The paired-C raster contains dimensional material and a restrained
contact shadow; this is asset depth, not a reusable control-shadow token.
Navigation disclosures overlay content with a white fill, fine border and z-index.

## Shapes

Controls have small rounded corners: shared actions and code surfaces use
`control`, copy buttons use `copy`, search uses `search`, and homepage setup
uses `home-action`. Data rows and use links stay unboxed. The two rounded,
interlocking C forms are an authored decorative object; the compact header
symbol is a separate SVG. Neither supplies an invented live interface.

## Components

### Actions and installation

Primary actions are compact filled links with white text. The homepage setup
link has a minimum height of 44px; the shared action minimum is 39px. Hover uses
the matching scope's darker accent. Keyboard focus uses the shared 2px accent
outline with a 4px offset.

The homepage command panel stays light, with a fine border and a copy button in
the top right. Its copy control has a 48px minimum width and 35px minimum height;
copy hover uses the scoped light fill. Copy is progressive enhancement: command
text remains available without the script.

### Navigation

The header prioritizes Guides, Integrations and Docs. A native Reading disclosure
exposes Comparisons, Research and Reports. Every section is present in initial
HTML and in the compact footer. Search remains a dedicated page. At 700px,
Menu replaces desktop navigation and the header GitHub link. Current links use
the applicable accent and an underline; disclosures retain native keyboard behavior.

### Reading, search and example

Interior reading uses real headings, ordinary links and keyboard-scrollable wide
tables. Search is a light bordered field with progressive results. The homepage
example is a two-entry definition list with real dividers, explicitly labelled
illustrative; it is not a product capture or a live state.

### Decorative object and provenance

`public/assets/acc-helper-v1.webp` is the generated decorative blue/yellow paired-C
object: 900×600, alpha preserved, 45,232 bytes. The homepage marks its container
`aria-hidden="true"` and gives the image an empty alt. It is not a screenshot of
ACC. Its dimensions are declared in HTML and it scales proportionally.

The exact native-image-tool prompt is retained privately at
`.impeccable/mocks/expressive/helper-object-prompt-exact.txt`. The shipping sidecar,
`public/assets/acc-helper-v1.webp.json`, retains that prompt with only the local
reference-image path normalized to `selected-installation-comp.png`; all creative
instructions match. The generated PNG was converted to the shipping alpha WebP.
The reference composition guides this object, not the rest of the site layout.

## Do's and Don'ts

### Do:

- **Do** keep all surfaces light, including command blocks and navigation overlays.
- **Do** preserve scoped homepage and interior tokens and the six reading families.
- **Do** keep native disclosures, ordinary links, visible focus and readable tables.
- **Do** label illustrative exchanges and retain raster provenance beside shipping assets.
- **Do** preserve all 22 manuscripts, anchors, metadata and canonical URLs.

### Don't:

- **Don't** introduce a theme control, dark code surface or invented dashboard.
- **Don't** present the decorative object or an example exchange as captured product behavior.
- **Don't** use a receipt to claim model attention or invent client capability, traction or evidence.
- **Don't** extend the bounded homepage review into a whole-site completion or approval claim.
