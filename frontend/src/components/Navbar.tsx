"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useInterwovenKit } from "@initia/interwovenkit-react";
import { useState, useRef, useEffect } from "react";

interface NavItem {
  label: string;
  href?: string;
  children?: { href: string; label: string; desc: string }[];
}

const navItems: NavItem[] = [
  {
    label: "Protocol",
    children: [
      { href: "/stake", label: "Stake", desc: "Stake INIT, receive INITx" },
      { href: "/bridge", label: "Bridge", desc: "Bridge INIT from L1" },
    ],
  },
  {
    label: "DeFi",
    children: [
      { href: "/swap", label: "Swap", desc: "Trade INIT & INITx" },
      { href: "/liquidity", label: "Liquidity", desc: "Provide LP tokens" },
      { href: "/lend", label: "Lend", desc: "Borrow against INITx" },
      { href: "/leverage", label: "Leverage", desc: "Simulate looped yield" },
    ],
  },
  {
    label: "Governance",
    href: "/governance",
  },
  {
    label: "Portfolio",
    href: "/portfolio",
  },
];

function Dropdown({ item, pathname }: { item: NavItem; pathname: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  if (item.href) {
    return (
      <Link
        href={item.href}
        className={`px-3 py-1.5 rounded-lg text-[13px] font-medium transition-colors ${
          pathname === item.href
            ? "bg-white/8 text-white"
            : "text-[#71717A] hover:text-[#A1A1AA]"
        }`}
      >
        {item.label}
      </Link>
    );
  }

  const isChildActive = item.children?.some((c) => pathname === c.href);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className={`flex items-center gap-1 px-3 py-1.5 rounded-lg text-[13px] font-medium transition-colors ${
          isChildActive ? "bg-white/8 text-white" : "text-[#71717A] hover:text-[#A1A1AA]"
        }`}
      >
        {item.label}
        <svg
          className={`w-3 h-3 transition-transform ${open ? "rotate-180" : ""}`}
          fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div className="absolute top-full left-0 mt-2 dropdown-menu min-w-[220px] z-50 animate-fade">
          {item.children!.map((child) => (
            <Link
              key={child.href}
              href={child.href}
              onClick={() => setOpen(false)}
              className={`dropdown-item ${pathname === child.href ? "bg-white/6" : ""}`}
            >
              <div>
                <div>{child.label}</div>
                <div className="dropdown-item-desc">{child.desc}</div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

export default function Navbar() {
  const pathname = usePathname();
  const { address, username, openConnect, openWallet } = useInterwovenKit();
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <nav className="glass-nav sticky top-0 z-50">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-14">
          {/* Left: Logo + Nav */}
          <div className="flex items-center gap-6">
            <Link href="/" className="flex items-center gap-2">
              <svg width="24" height="24" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
                <rect width="32" height="32" rx="8" fill="white"/>
                <path d="M8 8h4v16H8V8zm12 0h4v16h-4V8zM14 14h4v4h-4v-4z" fill="#09090B"/>
              </svg>
              <span className="text-[15px] font-semibold text-white tracking-tight">InDex</span>
            </Link>
            <div className="hidden md:flex items-center gap-0.5">
              {navItems.map((item) => (
                <Dropdown key={item.label} item={item} pathname={pathname} />
              ))}
            </div>
          </div>

          {/* Right: Wallet + Mobile toggle */}
          <div className="flex items-center gap-2">
            <button
              onClick={address ? openWallet : openConnect}
              className={`rounded-lg text-[13px] font-medium transition-all ${
                address
                  ? "px-3 py-1.5 bg-white/6 text-[#A1A1AA] border border-white/8 hover:bg-white/10 backdrop-blur-sm"
                  : "px-4 py-1.5 bg-white text-[#09090B] hover:opacity-90 shadow-[0_0_20px_rgba(255,255,255,0.08)]"
              }`}
            >
              {address
                ? username || `${address.slice(0, 6)}...${address.slice(-4)}`
                : "Connect Wallet"}
            </button>

            {/* Mobile hamburger */}
            <button
              onClick={() => setMobileOpen(!mobileOpen)}
              className="md:hidden p-1.5 rounded-lg text-[#71717A] hover:text-[#A1A1AA] hover:bg-white/5"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                {mobileOpen ? (
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                ) : (
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
                )}
              </svg>
            </button>
          </div>
        </div>
      </div>

      {/* Mobile nav */}
      {mobileOpen && (
        <div className="md:hidden border-t border-white/6 bg-[#09090B]/95 backdrop-blur-xl animate-fade">
          <div className="px-4 py-3 space-y-1">
            {navItems.map((item) =>
              item.href ? (
                <Link
                  key={item.label}
                  href={item.href}
                  onClick={() => setMobileOpen(false)}
                  className={`block px-3 py-2 rounded-lg text-[13px] font-medium ${
                    pathname === item.href ? "bg-white/8 text-white" : "text-[#71717A]"
                  }`}
                >
                  {item.label}
                </Link>
              ) : (
                <div key={item.label}>
                  <div className="px-3 py-2 text-[11px] font-medium text-[#71717A] uppercase tracking-wider">
                    {item.label}
                  </div>
                  {item.children!.map((child) => (
                    <Link
                      key={child.href}
                      href={child.href}
                      onClick={() => setMobileOpen(false)}
                      className={`block px-3 py-2 pl-6 rounded-lg text-[13px] ${
                        pathname === child.href ? "bg-white/8 text-white font-medium" : "text-[#52525B]"
                      }`}
                    >
                      {child.label}
                      <span className="text-[11px] text-[#3F3F46] ml-2">{child.desc}</span>
                    </Link>
                  ))}
                </div>
              )
            )}
          </div>
        </div>
      )}
    </nav>
  );
}
