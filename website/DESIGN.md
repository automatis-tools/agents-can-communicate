---
name: Agents Can Communicate
description: A clear blue-and-yellow identity for independent coding-session communication.
colors:
  white: "#fff"
  paper: "#f5f7fb"
  ink: "#19283e"
  muted: "#59657a"
  accent: "#284b91"
  accent-hover: "#193667"
  brand-blue: "#3158c3"
  brand-yellow: "#f2c94c"
  amber: "#795700"
  yellow-paper: "#fff4ce"
  line: "#e0e5ed"
  control-hover: "#eaf0ff"
  scrollbar: "#9eafd0"
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
  home-story-title:
    fontFamily: '"Public Sans", sans-serif'
    fontSize: "30px"
    fontWeight: 600
    lineHeight: 1.22
    letterSpacing: "-.015em"
  home-story-title-mobile:
    fontFamily: '"Public Sans", sans-serif'
    fontSize: "26px"
    fontWeight: 600
    lineHeight: 1.22
    letterSpacing: "-.015em"
  home-faq-title:
    fontFamily: '"Public Sans", sans-serif'
    fontSize: "22px"
    fontWeight: 600
    lineHeight: 1.22
    letterSpacing: "-.015em"
  home-reading-title:
    fontFamily: '"Public Sans", sans-serif'
    fontSize: "23px"
    fontWeight: 600
    lineHeight: 1.35
  home-reading-title-mobile:
    fontFamily: '"Public Sans", sans-serif'
    fontSize: "21px"
    fontWeight: 600
    lineHeight: 1.35
  home-example:
    fontFamily: '"Public Sans", sans-serif'
    fontSize: "20px"
    fontWeight: 400
    lineHeight: 1.6
  home-example-mobile:
    fontFamily: '"Public Sans", sans-serif'
    fontSize: "18px"
    fontWeight: 400
    lineHeight: 1.6
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
  surface: "5px"
  search: "6px"
  action: "7px"
  tag: "3px"
spacing:
  inline-small: "8px"
  copy-gap: "16px"
  control-inset: "20px"
  install-gap: "24px"
  section-large: "40px"
components:
  button-primary:
    backgroundColor: "{colors.brand-blue}"
    textColor: "{colors.white}"
    rounded: "{rounded.action}"
    padding: "7px 20px"
  button-primary-hover:
    backgroundColor: "{colors.accent-hover}"
    textColor: "{colors.white}"
  button-outline:
    backgroundColor: "{colors.white}"
    textColor: "{colors.accent}"
    rounded: "{rounded.action}"
    padding: "7px 20px"
  button-outline-hover:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.accent}"
  code-install:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.surface}"
    typography: "{typography.code}"
    padding: "46px 20px 20px"
  report-tag:
    backgroundColor: "{colors.yellow-paper}"
    textColor: "{colors.amber}"
    rounded: "{rounded.tag}"
    padding: "3px 8px"
---

# Design System: Agents Can Communicate

## Overview

**Creative North Star: "The useful connection"**

One blue-and-yellow identity connects installation, practical workflows and
long-form reading. Public Sans, dark readable type, white space and light code
surfaces give the site a clear authored character. The paired-C mark expresses
connection; tactile illustrations bring related ideas into individual layouts.

Shared navigation, controls and semantic colors apply across every route.
Six index structures and six reading layouts retain their own measures and
hierarchy; eight article metadata types map onto those reading layouts.
Illustration placement follows the content rather than a repeated header slot.

**Key Characteristics:**

- White and pale surfaces throughout, with visible keyboard focus.
- Dark ink titles, deep blue inline links and a brighter blue action color.
- Yellow markers and pale-yellow details paired with legible ink or amber.
- Tactile cobalt/yellow illustrations composed for each reading context.

## Colors

Frontmatter records the implemented shared CSS palette. Roles distinguish
readable links from the brighter action and mark color.

### Primary

- **Link blue** (`accent`) is for inline links, current navigation, focus and caret.
  **Deep blue** (`accent-hover`) supplies link and filled-action hover feedback.
- **Brand blue** (`brand-blue`) fills primary actions and the flat paired-C mark.
  Headline/title links generally begin in ink, then gain link color and an
  underline on hover.

### Secondary

- **Brand yellow** (`brand-yellow`) belongs to the mark and setup-command border.
- **Amber** (`amber`) colors guide step markers and text on **yellow paper**
  (`yellow-paper`) report tags. Yellow paper also supplies text selection.
- Material illustrations retain cobalt and sunny yellow highlights and shadows;
  their shaded colors are not flat UI tokens.

### Neutral

White is the main field. Ink carries body text and most linked titles; muted
supports descriptions and metadata. Paper distinguishes code, tables and reading
surfaces. Line separates data and navigation. Control-hover and scrollbar serve
those specific states rather than introducing new content accents.

**The Contrast Rule.** Use link blue for ordinary links and white on brand-blue
actions. Bright yellow is a marker or background, never ordinary text on white.
Measured pairs are recorded in [BRAND.md](BRAND.md) and the sidecar; these source
calculations do not establish a complete accessibility certification.

## Typography

Self-hosted Public Sans serves interface text and headings, with loaded variable
weights 400–700. Georgia is retained for research essay body text. Commands use
the recorded system monospace stack.

- **Display:** home H1 is 46px, 39px at up to 1000px, and 34px at up to 700px,
  with a 24ch maximum. The frontmatter records each responsive role.
- **Home story headings:** below the opening, `home-story-title` is 30px and
  becomes `home-story-title-mobile` at 26px up to 700px. The FAQ keeps
  `home-faq-title` at 22px. Curated reading H3s use `home-reading-title` at 23px,
  then `home-reading-title-mobile` at 21px. These roles apply only to the homepage.
  Article titles retain their family sizes, generally 30–40px.
- **Body:** the site baseline is `body`; home prose uses `home-body`, with a 73ch
  default maximum and a 64ch story measure. Its opening explanation uses
  `home-description` at 49ch, reduced to 16px on mobile. Ordinary home prose
  becomes 15px there. Example speech uses `home-example` at 20px/1.6 and
  `home-example-mobile` at 18px/1.6.
- **Supporting text:** navigation is 14px; metadata and captions are generally
  13–14px. Home install code is 13px, falling to 12px on mobile.
- **Reading:** task/reference prose is 15–18px. Research uses `essay-body` on
  desktop; its mobile body and introduction are 21px and 23px respectively.

## Layout

Shared shells reach 1120px, with 32px side gutters and 20px gutters at up to
700px. The home opening uses a 1.15fr/1fr copy/object grid, then 1.2fr/1fr at
1000px and a single column at 700px. Its mobile object is 245px wide and appears
above the copy.

Below the opening, the homepage uses the full shared shell with separate
content-led compositions. An asymmetric .82fr/1.18fr introduction and labelled
two-session question/answer lead into a review feature, handoff ribbon,
two-column client setup ledger, pale-yellow local-boundary spread, two curated
research/report links plus a comparison link, then native FAQ and a final setup
action. Sections are generally separated by 64px, reduced to 44px on mobile.

The conversation and closing areas have distinct two-column ratios; the local
spread uses .8fr/1.2fr with 34px/40px padding. At 700px, conversation, ledger,
reading pair and closing stack. Review art floats left at 84px; handoff art
floats right at 76px. The local spread becomes a single block with 25px padding.
This homepage flow does not change the other route families or their measures.

Preserve six index forms: guide workflow/task list, client catalogue, comparison
matrix, research archive, engineering register and docs workspace. Reading
layouts remain guide outline, client setup sections, comparison tables, serif
essay, report provenance and reference navigation. Comparison-hub and reference
metadata retain their specific variants within these layouts.

**The Content Placement Rule.** Size and position an illustration beside the
content it explains, preserving the family hierarchy and reading measure.

| Index | Desktop illustration role | Mobile treatment |
| --- | --- | --- |
| Guides | 165px route beside the actual steps; 130px at tablet | 96px beside steps |
| Integrations | 110px connector in receiving-method aside | 110px floated by receiving explanation |
| Comparisons | 240px choice object within overview; 185px at tablet | 80px beside overview, action below |
| Research | 210px magnifier in archive's left margin; 150px at tablet | 135px before archive rows |
| Reports | 145px paper stack beside closing evidence note | 90px beside that note |
| Docs | 96px book beside quickstart commands | 80px by heading; commands span below |

Six selected articles reuse their relevant asset in the guide rail, client
identity, comparison method row, essay metadata margin, report record or docs
sidebar. Mobile uses closing guide/docs vignettes or contextual identity, method,
metadata and record placements. Other manuscripts do not acquire a mandatory
illustration. Exact family sizes live in the sidecar and source CSS.

Spacing remains contextual: recurring 8px, 16px, 20px, 24px and 40px steps coexist
with layout-specific gaps rather than a forced universal grid.

## Elevation & Depth

Interface surfaces are flat. Fine rules, pale fills and spacing separate content;
the sampled styles define no CSS box-shadow vocabulary. Navigation disclosures
overlay content with a white field and border. Dimensional material and restrained
contact shadows are baked into the illustrations, not inherited by controls.

## Shapes

Primary actions have 7px corners and a 44px minimum height across the site.
Code surfaces and disclosure panels use 5px corners; search fields use 6px,
copy controls 4px, and report tags 3px. Rows and ordinary link groups remain
unboxed. Rounded C forms and tactile object silhouettes provide identity while
retaining readable, flat text and controls.

## Components

### Actions, code and search

Primary actions use brand blue with white text, becoming deep blue on hover.
The comparison overview has a white outlined action with link-blue text; hover
uses paper and a blue border. Focus is a 2px link-blue outline with a 4px offset.

Install commands stay on paper with a fine line and yellow left border. Copy
sits at the top right, with a 48px minimum width and 35px minimum height; hover
adds the control-hover fill. Text remains available without script enhancement.
Search is a dedicated page with a light bordered field and progressive results.

### Homepage story sections

The example is real static HTML, explicitly labelled illustrative: two definition
list turns use blue and yellow left rules, role labels, generous speech type and
a delivery link in the caption. It carries no live messaging state.

Review reuses the research magnifier beside the copy at 210px (170px tablet),
while handoff reuses the reports paper at 112px on the opposite side of a yellow
left-rule ribbon. Mobile recomposes them as small contextual floats. These are
body-story roles, independent of the archive and report index placements.

The client ledger pairs ink client names with muted receiving/setup notes and
ordinary integration links. The local-boundary spread uses yellow paper, an
amber heading and ink explanatory text. Curated research and report articles
remain ink title links with short descriptions and category links; a comparison
link follows. Native FAQ sits beside the final setup action on desktop and
precedes it on mobile. All sections, headings and links are static HTML; shared
copy and disclosure behavior remains unchanged.

### Navigation and reading

Every route shares the paired-C mark, ACC wordmark, navigation and footer.
Guides, Integrations and Docs are direct links; native Reading exposes
Comparisons, Research and Reports. Current reading sections also mark the
Reading summary. At 700px, native Menu replaces desktop navigation. Every
section remains linked in initial HTML and the footer. Wide tables remain
keyboard-scrollable; disclosures and ordinary links keep native behavior.

### Mark and illustrations

The flat mark and favicon use brand-blue/yellow paths; social artwork shares
that flat palette. The header symbol is 52×34px beside the Public Sans wordmark.
The home paired-C object remains a 900×600 transparent WebP (45,232 bytes).
Six 512×512 transparent WebPs provide the route, connector, choice, magnifier,
paper and book subjects. Their original material, light/shadow range and alpha
are retained without recoloring or regeneration.

Decorative figures are hidden from assistive technology and use empty alt text;
they are not product captures or capability evidence. Source dimensions preserve
aspect ratio. Section/article illustrations load lazily. Each shipping WebP
retains its exact-prompt JSON sidecar. The hero's private exact prompt remains at
`.impeccable/mocks/expressive/helper-object-prompt-exact.txt`; its shipping sidecar
normalizes only the local reference path to `selected-installation-comp.png`.

## Do's and Don'ts

### Do:

- **Do** use shared semantic colors, mark, controls and navigation on every route.
- **Do** pair yellow accents with contrasting ink or amber and keep all surfaces light.
- **Do** compose illustration size and placement around actual content and responsive hierarchy.
- **Do** preserve six reading families, eight article metadata types, all 22 manuscripts, anchors, metadata and canonical URLs.
- **Do** keep visible focus, native disclosures, readable tables and asset provenance.

### Don't:

- **Don't** use bright yellow for ordinary text on white or make all linked titles blue.
- **Don't** apply an identical image size or upper-right image slot to every page.
- **Don't** flatten material illustrations into exact UI swatches or recolor their shading.
- **Don't** add a theme switch, dark command surface or invented product dashboard.
- **Don't** present illustrations, example exchanges or delivery receipts as proof of model attention or new client capability.
