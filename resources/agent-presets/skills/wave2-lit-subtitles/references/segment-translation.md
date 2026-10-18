# Segment Translation

Adapted from `shang-zhu/violin/prompts/translate.yaml` at the commit recorded in NOTICE.

The upstream batch rule requires exactly N translations for N input segments and preserves segment boundaries without merging or splitting. Native phrasing is preferred, while product names, standard technical acronyms, and names lacking established target forms may remain unchanged.

For SRT/VTT in this App: retain the source cue identifiers and timestamps, translate visible text only, inspect adjacent source segments for references, and compare each cue against its source after translation. This workflow does not call the upstream video API or TTS pipeline.
