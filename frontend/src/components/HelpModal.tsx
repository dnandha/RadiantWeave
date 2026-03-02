import React from "react";

type Props = {
  onClose: () => void;
};

export const HelpModal: React.FC<Props> = ({ onClose }) => {
  return (
    <div className="help-modal-overlay" onClick={onClose}>
      <div className="help-modal" onClick={(e) => e.stopPropagation()}>
        <div className="help-modal-header">
          <h2 className="help-modal-title">How to use RadiantWeave</h2>
          <button type="button" className="help-modal-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className="help-modal-body">
          <p className="help-modal-intro">
            Design underfloor heating circuits by drawing rooms, zones, placing the manifold, and
            connecting pipes to circuit inlets.
          </p>

          <ol className="help-modal-steps">
            <li>
              <strong>Create rooms</strong> — Select &quot;Create rooms&quot; and click two opposite
              corners on the canvas to draw each room rectangle. Use &quot;Edit rooms&quot; to resize
              or move them.
            </li>
            <li>
              <strong>Create zones</strong> — Select &quot;Create zones&quot; and draw a rectangle
              inside a room for the heated area. You can set pipe spacing per zone in the sidebar.
              Use &quot;Edit zones&quot; to adjust zones.
            </li>
            <li>
              <strong>Place manifold</strong> — Select &quot;Place manifold&quot; and click where the
              manifold should sit (e.g. in a cupboard or on the wall). You can also edit X/Y in the
              sidebar.
            </li>
            <li>
              <strong>Calculate circuits</strong> — Click &quot;Calculate circuits&quot; so the app
              generates pipe routes for each zone. Set &quot;Max length per circuit&quot; if needed.
            </li>
            <li>
              <strong>Add connections</strong> — Select &quot;Add connection&quot;. Start at the
              manifold (red dot) or at a circuit inlet (white circle), add path points (horizontal
              and vertical only), then finish at an inlet or the manifold. Each circuit needs one
              pipe to its inlet.
            </li>
            <li>
              <strong>Move inlet</strong> — Select &quot;Move inlet&quot; and drag a circuit’s inlet
              (white circle) along the zone (or subzone) border to change where the pipe connects.
            </li>
          </ol>

          <p className="help-modal-tips">
            <strong>Tips:</strong> Use the <strong>Floor</strong> tabs to add or switch between
            floors; each floor has its own rooms, zones, manifold, and connections. Use &quot;Save
            layout&quot; / &quot;Load layout&quot; to keep your design (all floors are saved).
            Circuits without an inlet connection appear faded. Press <kbd>Esc</kbd> to cancel a
            draft or in-progress connection.
          </p>
        </div>
      </div>
    </div>
  );
};
