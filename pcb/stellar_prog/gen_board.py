#!/usr/bin/python3
"""Generate stellar_prog.kicad_pcb: single-sided programmer for the L3N battery-insert pogo block.

Board frame = the block's pin-tail face viewed from above, copper side up (same view as the
tag's pad block when looking into the battery compartment), origin top-left, KiCad Y-down.

Revisions:
  rev 1  grid from "battery insert.3mf" with Y = 9 - y_3mf: mirrored about the horizontal axis.
  rev 2  X = x_3mf + 36, Y = y_3mf + 18 (grid 25.90 / 13.97). Correct orientation, but every pogo
         landed slightly off its tag pad.
  rev 3  grid from the corrected block, drawing pcb/"battery insert back.svg" (2026-11-02):
         53 x 27, R2, first column 25.10 from the left edge, top row 13.93 from the top edge,
         2.54 pitch both ways. Same orientation as rev 2 (shift -0.80 X, -0.04 Y).
         Pogo pads 2.0 -> 2.2 mm; R1 (1k 0603) in series with SWS. 1x8 SMD header J1 on the left
         edge. Archived as fab/stellar_prog_rev3.kicad_pcb (+ fab/gen_board_rev3.py).
  rev 4  (2026-11-05) J1 replaced by a Waveshare RP2350-Zero (U1) soldered flat by its castellations
         (footprint from the multi_probe_horizontal project: stellar_prog.pretty/RP2350-Zero), with
         the footprint's through-board cutout under the module. Outline and pogo grid unchanged.

rev 4 layout:
  U1 is rotated 180 deg with its USB-C flush with the bottom edge, so its GP14..GP29/3V3/GND column
  faces the pogo grid. Every route fans out from that column, in order, to the side of the grid it
  can reach on one layer:

      U1 pad   net (U1 side)  -> tag pad    how
      GP14     X1_GP          -> X1         over everything, down into the pad through JP2 (DNP)
      GP15     RXD            -> RXD        level, then 45 deg down into the pad from above
      GP26     SWS            -> SWS        R1 1k on the diagonal, into the pad from the left
      GP27     TXD            -> TXD        into the pad from the left
      GP28     X2_GP          -> X2         under the grid, through JP3 (DNP solder jumper)
      GP29     NRST           -> NRST       under the grid
      3V3      VCC            -> VCC        under the grid, up the right side
      GND      GND            -> GND        under the grid, JP1 (0R 1206) straddling the VCC track

  The U1 3V3/GND order is the mirror of the tag's VCC/GND, so exactly one crossing is unavoidable
  on one layer; JP1 is it. X1/X2 are still unidentified: JP2/JP3 stay open until they are metered.

  R1 and the jumpers carry 1.0 mm copper labels ("1k", "JP1".."JP3"). RXD stays level until
  RXD_JOG_X to leave room for "1k" above R1, and the under-grid lanes sit low enough to leave room
  for "JP3" under JP3 (the first rev 4 layout had neither).

  Firmware consequences (firmware/, `rp2350` feature): RXD on GP15 and TXD on GP27 are not a
  hardware UART TX/RX pair, so the tag UART is a PIO UART. SWS on GP26, NRST on GP29.

Milling: fab/ holds Carvera G-code made from the saved board by a CAM script that is not part of
this repo; it cuts the U1 cutout as an interior profile before the outline.

Run with the system python (pcbnew bindings): /usr/bin/python3 gen_board.py
"""
import math
import os
import pcbnew

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "stellar_prog.kicad_pcb")
REV = 4

OX, OY = 100.0, 100.0          # sheet offset of the board's top-left corner
W, H, R = 53.0, 27.0, 2.0      # outline, corner radius

TRACK_W = 0.7
CLEARANCE = 0.3                # >= the 30 deg V-bit kerf (0.2 tip at 0.05 deep: 0.23 mm)
EDGE_CLEARANCE = 0.3
POGO_DRILL = 1.2               # tails measure 0.9-1.0 mm; slack for printed-hole lean
POGO_PAD = 2.2                 # 0.5 mm ring; leaves 0.34 mm between neighbours

# Pogo grid (board frame). Columns left->right, rows top/bottom.
COLS = [25.10 + 2.54 * i for i in range(4)]
ROW_T = 13.93
ROW_B = ROW_T + 2.54

# Pad identities as silkscreened on HS_EL5102 (viewed from above, MODEL label to the right).
# X1/X2 are the two unlabelled pads. SWS and GND get *_TAG nets: R1 and JP1 sit between them and U1.
TOP = ["SWS_TAG", "RXD", "X1", "VCC"]
BOT = ["TXD", "X2", "NRST", "GND_TAG"]

LIB = os.path.join(HERE, "stellar_prog.pretty")
SMD_LIB = "/usr/share/kicad/footprints/Resistor_SMD.pretty"
R0603 = "R_0603_1608Metric_Pad0.98x0.95mm_HandSolder"
R1206 = "R_1206_3216Metric_Pad1.30x1.75mm_HandSolder"

# U1: RP2350-Zero, 180 deg, body (18 x 23.5) flush with the bottom edge. X leaves 1 mm between the
# unused far-side pads and the left edge (the bottom-left pad corner then clears the R2 arc).
U1_XY = (11.0, H - 11.75)
U1_NETS = {"GP14": "X1_GP", "GP15": "RXD", "GP26": "SWS", "GP27": "TXD", "GP28": "X2_GP",
           "GP29": "NRST", "3V3": "VCC", "GND": "GND"}

XJ = 21.34                     # every fan-out diagonal starts here (just right of U1's pads)
RXD_JOG_X = 24.0               # RXD stays level to here, then 45 deg down to its pad's column
LANE_X2 = 18.5                 # under the grid
LANE_NRST = 21.3               # leaves room for the "JP3" label between X2 and NRST
LANE_VCC = 22.3
LANE_GND = 24.1
VCC_RISE_X = 34.6              # VCC climbs the right side of the grid here


def mm(x, y):
    return pcbnew.VECTOR2I(pcbnew.FromMM(OX + x), pcbnew.FromMM(OY + y))


def unmm(v):
    return (round(pcbnew.ToMM(v.x) - OX, 4), round(pcbnew.ToMM(v.y) - OY, 4))


def main():
    board = pcbnew.BOARD()
    board.SetCopperLayerCount(2)
    ds = board.GetDesignSettings()
    ds.m_MinClearance = pcbnew.FromMM(CLEARANCE)
    ds.m_TrackMinWidth = pcbnew.FromMM(0.5)
    ds.m_CopperEdgeClearance = pcbnew.FromMM(EDGE_CLEARANCE)
    nc = ds.m_NetSettings.GetDefaultNetclass()
    nc.SetClearance(pcbnew.FromMM(CLEARANCE))
    nc.SetTrackWidth(pcbnew.FromMM(TRACK_W))
    ds.SetAuxOrigin(mm(0, H))

    nets = {}

    def net(name):
        if name not in nets:
            n = pcbnew.NETINFO_ITEM(board, name)
            board.Add(n)
            nets[name] = n
        return nets[name]

    # Outline
    def edge_line(a, b):
        s = pcbnew.PCB_SHAPE(board, pcbnew.SHAPE_T_SEGMENT)
        s.SetLayer(pcbnew.Edge_Cuts)
        s.SetWidth(pcbnew.FromMM(0.1))
        s.SetStart(mm(*a))
        s.SetEnd(mm(*b))
        board.Add(s)

    def edge_arc(cx, cy, a0):
        s = pcbnew.PCB_SHAPE(board, pcbnew.SHAPE_T_ARC)
        s.SetLayer(pcbnew.Edge_Cuts)
        s.SetWidth(pcbnew.FromMM(0.1))
        pts = [(cx + R * math.cos(math.radians(a)), cy + R * math.sin(math.radians(a)))
               for a in (a0, a0 + 45, a0 + 90)]
        s.SetArcGeometry(mm(*pts[0]), mm(*pts[1]), mm(*pts[2]))
        board.Add(s)

    edge_line((R, 0), (W - R, 0))
    edge_line((W, R), (W, H - R))
    edge_line((W - R, H), (R, H))
    edge_line((0, H - R), (0, R))
    edge_arc(R, R, 180)
    edge_arc(W - R, R, 270)
    edge_arc(W - R, H - R, 0)
    edge_arc(R, H - R, 90)

    # Pogo tails: through-hole pads, copper on F.Cu only (single-sided stock).
    p1 = pcbnew.FOOTPRINT(board)
    p1.SetReference("P1")
    p1.SetValue("L3N_pogo_2x4")
    p1.Reference().SetVisible(False)
    p1.Value().SetVisible(False)
    board.Add(p1)
    p1.SetPosition(mm(COLS[0], ROW_T))
    tht_layers = pcbnew.LSET()
    tht_layers.AddLayer(pcbnew.F_Cu)
    pogo = {}
    for row_y, names, base in ((ROW_T, TOP, 1), (ROW_B, BOT, 5)):
        for i, name in enumerate(names):
            pad = pcbnew.PAD(p1)
            pad.SetNumber(str(base + i))
            pad.SetAttribute(pcbnew.PAD_ATTRIB_PTH)
            pad.SetShape(pcbnew.PAD_SHAPE_CIRCLE)
            pad.SetSize(pcbnew.VECTOR2I(pcbnew.FromMM(POGO_PAD), pcbnew.FromMM(POGO_PAD)))
            pad.SetDrillSize(pcbnew.VECTOR2I(pcbnew.FromMM(POGO_DRILL), pcbnew.FromMM(POGO_DRILL)))
            pad.SetLayerSet(tht_layers)
            p1.Add(pad)
            pad.SetPosition(mm(COLS[i], row_y))
            pad.SetNet(net(name))
            pogo[name] = (COLS[i], row_y)

    def place(lib, name, ref, value, xy, deg, pad_nets):
        fp = pcbnew.FootprintLoad(lib, name)
        if fp is None:
            raise SystemExit(f"footprint {name} not found in {lib}")
        fp.SetReference(ref)
        fp.SetValue(value)
        board.Add(fp)
        fp.SetOrientationDegrees(deg)
        fp.SetPosition(mm(*xy))
        for num, n in pad_nets.items():
            fp.FindPadByNumber(num).SetNet(net(n))
        return fp, {p.GetNumber(): unmm(p.GetPosition()) for p in fp.Pads()}

    _, u1 = place(LIB, "RP2350-Zero", "U1", "RP2350-Zero", U1_XY, 180, U1_NETS)
    # R1 and JP3 sit on 45 deg diagonals / lanes worked out in the docstring's table; pad 1 faces U1.
    sws_diag = lambda t: (XJ + t, u1["GP26"][1] + t)
    _, r1 = place(SMD_LIB, R0603, "R1", "1k", sws_diag(1.75), -45, {"1": "SWS", "2": "SWS_TAG"})
    _, jp2 = place(SMD_LIB, R0603, "JP2", "DNP", (COLS[2], 8.4), -90, {"1": "X1_GP", "2": "X1"})
    _, jp3 = place(SMD_LIB, R0603, "JP3", "DNP", (26.1, LANE_X2), 0, {"1": "X2_GP", "2": "X2"})
    _, jp1 = place(SMD_LIB, R1206, "JP1", "0R", (COLS[3], LANE_VCC), -90, {"1": "GND_TAG", "2": "GND"})
    for name, (a, b) in (("R1", r1.values()), ("JP2", jp2.values()), ("JP3", jp3.values()),
                         ("JP1", jp1.values())):
        print(f"{name} pads at {a} {b}")
    # JP1 rotated -90: pad 1 must be the upper (pogo) one.
    assert jp1["1"][1] < jp1["2"][1], jp1
    assert jp2["1"][1] < jp2["2"][1], jp2  # JP2 rotated -90: pad 1 (U1 side) on top
    assert r1["1"][0] < r1["2"][0] and r1["1"][1] < r1["2"][1], r1

    # Tracks
    def track(pts, n):
        for a, b in zip(pts, pts[1:]):
            t = pcbnew.PCB_TRACK(board)
            t.SetLayer(pcbnew.F_Cu)
            t.SetWidth(pcbnew.FromMM(TRACK_W))
            t.SetStart(mm(*a))
            t.SetEnd(mm(*b))
            t.SetNet(net(n))
            board.Add(t)

    def fan(pad, lane):
        """U1 pad -> XJ -> 45 deg down to `lane`. Returns the corner points."""
        x, y = u1[pad]
        return [(x, y), (XJ, y), (XJ + lane - y, lane)]

    track([u1["GP14"], (pogo["X1"][0], u1["GP14"][1]), jp2["1"]], "X1_GP")
    track([jp2["2"], pogo["X1"]], "X1")
    rx, ry = pogo["RXD"][0], u1["GP15"][1]
    track([u1["GP15"], (RXD_JOG_X, ry), (rx, ry + rx - RXD_JOG_X), pogo["RXD"]], "RXD")
    track([u1["GP26"], (XJ, u1["GP26"][1]), r1["1"]], "SWS")
    track([r1["2"], pogo["SWS_TAG"]], "SWS_TAG")
    track(fan("GP27", pogo["TXD"][1]), "TXD")
    assert abs(XJ + pogo["TXD"][1] - u1["GP27"][1] - pogo["TXD"][0]) < 1e-3, "TXD diagonal misses its pad"
    track(fan("GP28", LANE_X2) + [jp3["1"]], "X2_GP")
    track([jp3["2"], pogo["X2"]], "X2")
    track(fan("GP29", LANE_NRST) + [(pogo["NRST"][0], LANE_NRST), pogo["NRST"]], "NRST")
    track(fan("3V3", LANE_VCC) + [(VCC_RISE_X, LANE_VCC), (VCC_RISE_X, pogo["VCC"][1]), pogo["VCC"]], "VCC")
    track(fan("GND", LANE_GND) + [(jp1["2"][0], LANE_GND), jp1["2"]], "GND")
    track([jp1["1"], pogo["GND_TAG"]], "GND_TAG")

    # Copper legend (no silkscreen on a milled board).
    def text(s, x, y, size=1.5, thick=0.3):
        t = pcbnew.PCB_TEXT(board)
        t.SetText(s)
        t.SetLayer(pcbnew.F_Cu)
        t.SetTextSize(pcbnew.VECTOR2I(pcbnew.FromMM(size), pcbnew.FromMM(size)))
        t.SetTextThickness(pcbnew.FromMM(thick))
        t.SetHorizJustify(pcbnew.GR_TEXT_H_ALIGN_LEFT)
        t.SetPosition(mm(x, y))
        board.Add(t)

    text("L3N PROG", 37.0, 2.4, size=1.8, thick=0.35)
    text(f"rev {REV}", 37.0, 5.0)
    for i, s in enumerate(["SWS GP26", "RXD GP15", "TXD GP27", "NRST GP29", "X1 GP14", "X2 GP28"]):
        text(s, 37.0, 9.2 + 2.6 * i)

    # Part labels, next to their parts (positions found by DRC + pcb_mill.py's isolation check).
    for s, x, y in (("1k", 22.5, 9.6), ("JP2", 26.3, 8.4), ("JP3", 25.2, 20.0), ("JP1", 31.2, 25.7)):
        text(s, x, y, size=1.0, thick=0.25)

    pcbnew.SaveBoard(OUT, board)
    # rev 3 exempted J1 from edge clearance in a .kicad_dru; nothing needs an exemption now.
    dru = os.path.splitext(OUT)[0] + ".kicad_dru"
    if os.path.exists(dru):
        os.remove(dru)
    print("wrote", OUT)


if __name__ == "__main__":
    main()
