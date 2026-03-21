# Excalidraw - Example diagram

## Diagram Being Built

A top-down zoned relationship map for a software engineering team. Five horizontal zones stacked vertically, connected by arrows that must cross multiple zones without overlapping intermediate boxes.

### Zones (top to bottom)

| Zone | Entity Type | Shape | Color | Count |
|------|-------------|-------|-------|-------|
| Team Members | People | Ellipse 180×120 | Blue fill `#d0ebff` | ~6 |
| Products | Product areas | Rectangle 180×60 | Green fill `#d3f9d8` | ~8 |
| Work Items | Jira epics | Rectangle 180×60 | Purple fill `#e5dbff` | ~18, stacked 1-6 per product column |
| Initiatives | Strategic initiatives | Rectangle 220×70 | Orange fill `#fff3bf` | ~5 |
| Objectives | High-level goals | Rectangle 220×60 | Red fill `#ffe3e3` | ~3 |

### Layout

```
Zone: Team Members     [Alice]  [Bob]  [Carol]  [Dave]  [Eve]  [Frank]
                          |       |       |        |       |       |
Zone: Products         [Svc-A] [Svc-B] [Svc-C] [Svc-D] [Svc-E] [Svc-F] [Svc-G] [Svc-H]
                          |       |       |        |       |       |
Zone: Work Items       [E-1]   [E-4]   [E-6]   [E-8]   [E-12]  [E-16]  [E-17]
                       [E-2]   [E-5]           [E-9]   [E-13]  
                       [E-3]                   [E-10]  [E-14]  
                                               [E-11]  [E-15]  
                          \       |      /        \       |
Zone: Initiatives      [Init-A]  [Init-B]   [Init-C]  [Init-D]   [Init-E]
                                    |                     |          |
Zone: Objectives                [Obj-1]               [Obj-2]    [Obj-3]
```

### Arrow Types

| Arrow | Color | Style | Direction | Crosses zones |
|-------|-------|-------|-----------|---------------|
| Person → Product | Blue `#1971c2` | Solid | Down 1 zone | No — adjacent zones |
| Epic → Product | Purple `#7048e8` | Solid | Up 1 zone | No — adjacent zones |
| Initiative → Product | Orange `#e8590c` | Solid | Up 3 zones | **Yes** — through Work Items zone |
| Epic → Initiative | Orange `#e8590c` | Dashed | Down 2 zones | **Yes** — through gap below Work Items |
| Objective → Initiative | Red `#c92a2a` | Dashed | Up 1 zone | No — adjacent zones |
