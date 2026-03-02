import React, { useEffect, useRef, useState } from "react";

type MenuItem = {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
};

type Props = {
  items: MenuItem[];
  title?: string;
  className?: string;
};

export const ActionsMenu: React.FC<Props> = ({ items, title = "Actions", className }) => {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open]);

  return (
    <div className={`actions-menu ${className ?? ""}`} ref={wrapperRef}>
      <button
        type="button"
        className="actions-menu-trigger"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        title={title}
        aria-label={title}
      >
        ⋮
      </button>
      {open && (
        <div className="actions-menu-dropdown" role="menu">
          {items.map((item, i) => (
            <button
              key={i}
              type="button"
              role="menuitem"
              className={`actions-menu-item ${item.danger ? "actions-menu-item--danger" : ""}`}
              disabled={item.disabled}
              onClick={() => {
                item.onClick();
                setOpen(false);
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};
