#!/usr/bin/python3
"""Generate stellar_prog.kicad_pcb: single-sided breakout for the L3N battery-insert pogo block.

Board frame = the block's pin-tail face viewed from above, copper side up (same view as the
tag's pad block when looking into the battery compartment), origin top-left, KiCad Y-down.
Header J1 is SMD pads on the left edge for a straight 0.1" header soldered flat.

Revisions:
  rev 1  grid from "battery insert.3mf" with Y = 9 - y_3mf: mirrored about the horizontal axis.
  rev 2  X = x_3mf + 36, Y = y_3mf + 18 (grid 25.90 / 13.97). Correct orientation, but every pogo
         landed slightly off its tag pad.
  rev 3  grid from the corrected block, drawing pcb/"battery insert back.svg" (2026-11-02):
         53 x 27, R2, first column 25.10 from the left edge, top row 13.93 from the top edge,
         2.54 pitch both ways. Same orientation as rev 2 (shift -0.80 X, -0.04 Y).
         Pogo pads 2.0 -> 2.2 mm; R1 (1k 0603) in series with SWS, replacing the inline
         resistor of the pico-sws wiring.

Milling: tools/pcb_mill.py turns the saved board into Carvera G-code (fab/).

Run with the system python (pcbnew bindings): /usr/bin/python3 gen_board.py
"""
import math
import os
import pcbnew

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "stellar_prog.kicad_pcb")

OX, OY = 100.0, 100.0          # sheet offset of the board's top-left corner
W, H, R = 53.0, 27.0, 2.0      # outline, corner radius

TRACK_W = 0.7
CLEARANCE = 0.3                # >= the 30 deg V-bit kerf (0.2 tip at 0.05 deep: 0.23 mm)
POGO_DRILL = 1.2               # tails measure 0.9-1.0 mm; slack for printed-hole lean
POGO_PAD = 2.2                 # 0.5 mm ring; leaves 0.34 mm between neighbours
HDR_PAD = (5.0, 1.5)           # along X, along Y
HDR_X0 = 0.0                   # pads run to the board edge

# Pogo grid (board frame). Columns left->right, rows top/bottom.
COLS = [25.10 + 2.54 * i for i in range(4)]
ROW_T = 13.93
ROW_B = ROW_T + 2.54

# Pad identities as silkscreened on HS_EL5102 (viewed from above, MODEL label to the right).
# X1/X2 are the two unlabelled pads.
TOP = ["SWS", "RXD", "X1", "VCC"]
BOT = ["TXD", "X2", "NRST", "GND"]

# Header order top->bottom falls out of the single-layer fanout: top row outermost-first, then bottom row.
HDR_ORDER = ["VCC", "X1", "RXD", "SWS", "TXD", "X2", "NRST", "GND"]
HDR_Y = [H / 2 + (i - 3.5) * 2.54 for i in range(8)]
HDR_XC = HDR_X0 + HDR_PAD[0] / 2

# Horizontal channel Y for each net before its 45 deg jog down to the header row.
# Outer rows clear the inner pads by 2.29 mm, then 2.6 mm pitch outward.
CHANNEL_Y = {"VCC": ROW_T - 7.49, "X1": ROW_T - 4.89, "RXD": ROW_T - 2.29, "SWS": ROW_T,
             "TXD": ROW_B, "X2": ROW_B + 2.29, "NRST": ROW_B + 4.89, "GND": ROW_B + 7.49}
JOG_X = 16.0                   # every jog starts here, so the diagonals run parallel

# R1: SWS series resistor on the SWS channel between the jog and the pogo pad.
# Pogo side net SWS_TAG, header side keeps the name SWS.
R1_FP = ("/usr/share/kicad/footprints/Resistor_SMD.pretty", "R_0603_1608Metric_Pad0.98x0.95mm_HandSolder")
R1_X = 20.5
R1_PITCH = 1.825               # pad centre to pad centre in that footprint


def mm(x, y):
    return pcbnew.VECTOR2I(pcbnew.FromMM(OX + x), pcbnew.FromMM(OY + y))


def main():
    board = pcbnew.BOARD()
    board.SetCopperLayerCount(2)
    ds = board.GetDesignSettings()
    ds.m_MinClearance = pcbnew.FromMM(CLEARANCE)
    ds.m_TrackMinWidth = pcbnew.FromMM(0.5)
    ds.m_CopperEdgeClearance = 0  # real 0.3 mm limit lives in the .kicad_dru (J1 exempt)
    nc = ds.m_NetSettings.GetDefaultNetclass()
    nc.SetClearance(pcbnew.FromMM(CLEARANCE))
    nc.SetTrackWidth(pcbnew.FromMM(TRACK_W))
    ds.SetAuxOrigin(mm(0, H))

    nets = {}
    for name in HDR_ORDER + ["SWS_TAG"]:
        n = pcbnew.NETINFO_ITEM(board, name)
        board.Add(n)
        nets[name] = n

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
            pad.SetNet(nets["SWS_TAG" if name == "SWS" else name])

    # Header: SMD pads at the left edge.
    j1 = pcbnew.FOOTPRINT(board)
    j1.SetReference("J1")
    j1.SetValue("hdr_1x8_flat")
    j1.Reference().SetVisible(False)
    j1.Value().SetVisible(False)
    board.Add(j1)
    j1.SetPosition(mm(HDR_XC, HDR_Y[0]))
    for i, name in enumerate(HDR_ORDER):
        pad = pcbnew.PAD(j1)
        pad.SetNumber(str(i + 1))
        pad.SetAttribute(pcbnew.PAD_ATTRIB_SMD)
        pad.SetShape(pcbnew.PAD_SHAPE_RECT)
        pad.SetSize(pcbnew.VECTOR2I(pcbnew.FromMM(HDR_PAD[0]), pcbnew.FromMM(HDR_PAD[1])))
        pad.SetLayerSet(pad.SMDMask())
        j1.Add(pad)
        pad.SetPosition(mm(HDR_XC, HDR_Y[i]))
        pad.SetNet(nets[name])

    # R1, pads along X on the SWS channel: pad 1 (left) to the header, pad 2 (right) to the pogo.
    r1 = pcbnew.FootprintLoad(*R1_FP)
    r1.SetReference("R1")
    r1.SetValue("1k")
    board.Add(r1)
    r1.SetPosition(mm(R1_X, ROW_T))
    r1.FindPadByNumber("1").SetNet(nets["SWS"])
    r1.FindPadByNumber("2").SetNet(nets["SWS_TAG"])

    # Tracks
    def track(pts, net):
        for a, b in zip(pts, pts[1:]):
            t = pcbnew.PCB_TRACK(board)
            t.SetLayer(pcbnew.F_Cu)
            t.SetWidth(pcbnew.FromMM(TRACK_W))
            t.SetStart(mm(*a))
            t.SetEnd(mm(*b))
            t.SetNet(net)
            board.Add(t)

    pad_xy = {}
    for i, name in enumerate(TOP):
        pad_xy[name] = (COLS[i], ROW_T)
    for i, name in enumerate(BOT):
        pad_xy[name] = (COLS[i], ROW_B)

    for i, name in enumerate(HDR_ORDER):
        px, py = pad_xy[name]
        cy, hy = CHANNEL_Y[name], HDR_Y[i]
        dy = hy - cy
        if name == "SWS":  # split at R1
            track([(px, py), (R1_X + R1_PITCH / 2, cy)], nets["SWS_TAG"])
            px = R1_X - R1_PITCH / 2
        pts = [(px, py)]
        if abs(cy - py) > 1e-6:
            pts.append((px, cy))
        pts += [(JOG_X, cy), (JOG_X - abs(dy), hy), (HDR_XC, hy)]
        track(pts, nets[name])

    # Copper legend (no silkscreen on a milled board).
    def text(s, x, y, size=1.5, thick=0.3, left=True):
        t = pcbnew.PCB_TEXT(board)
        t.SetText(s)
        t.SetLayer(pcbnew.F_Cu)
        t.SetTextSize(pcbnew.VECTOR2I(pcbnew.FromMM(size), pcbnew.FromMM(size)))
        t.SetTextThickness(pcbnew.FromMM(thick))
        if left:
            t.SetHorizJustify(pcbnew.GR_TEXT_H_ALIGN_LEFT)
        t.SetPosition(mm(x, y))
        board.Add(t)

    text("L3N PROG", 37.5, 25.2, size=1.8, thick=0.35)
    text("rev 3", 39.0, 2.2)
    for i, name in enumerate(HDR_ORDER):
        text(f"{i + 1} {name}", 39.0, HDR_Y[i])
    # Pin numbers at the header ends.
    text("1", HDR_XC, HDR_Y[0] - 2.4, left=False)
    text("8", HDR_XC, HDR_Y[-1] + 2.4, left=False)

    pcbnew.SaveBoard(OUT, board)
    # J1 pads run flush to the edge on purpose. Board-setup minimums can't be relaxed by rules,
    # so the board-wide edge clearance is 0 and the 0.3 mm limit is applied here to all but J1.
    not_j1 = "!A.memberOfFootprint('J1') && !B.memberOfFootprint('J1')"
    with open(os.path.splitext(OUT)[0] + ".kicad_dru", "w") as f:
        f.write('(version 1)\n'
                '(rule "J1 flush to edge"\n'
                '  (severity ignore)\n'
                '  (constraint edge_clearance)\n'
                f'  (condition "!({not_j1})"))\n'
                '(rule "edge clearance"\n'
                '  (constraint edge_clearance (min 0.3mm))\n'
                f'  (condition "{not_j1}"))\n')
    print("wrote", OUT)


if __name__ == "__main__":
    main()
