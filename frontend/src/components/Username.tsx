"use client";

import { useUsernameQuery } from "@initia/interwovenkit-react";

interface UsernameProps {
  address: string;
  className?: string;
}

/** Resolves and displays an Initia Username (.init) for a given address. Falls back to truncated address. */
export default function Username({ address, className }: UsernameProps) {
  const { data: username, isLoading } = useUsernameQuery(address);

  if (isLoading) {
    return <span className={className}>{`${address.slice(0, 8)}...${address.slice(-4)}`}</span>;
  }

  return (
    <span className={className} title={address}>
      {username || `${address.slice(0, 8)}...${address.slice(-4)}`}
    </span>
  );
}
