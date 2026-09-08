import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { Button } from "@/components/ui/button";

export function BackLink({ href, label }: { href: string; label: string }) {
  return (
    <Button
      nativeButton={false}
      render={<Link href={href} aria-label={`Back to ${label}`} />}
      variant="ghost"
      size="sm"
      className="-ml-2 w-fit cursor-pointer"
    >
      <ChevronLeft aria-hidden />
      {label}
    </Button>
  );
}
