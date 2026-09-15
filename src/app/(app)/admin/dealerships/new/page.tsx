import type { Metadata } from "next";
import Link from "next/link";
import { requireAdmin } from "@/lib/auth/guards";
import { getSettings } from "@/lib/settings";
import { env } from "@/lib/env";
import { allRegions, regionLabel } from "@/lib/crawler/regions";
import { createDealershipAction } from "@/app/actions/dealerships";
import { DealershipForm } from "@/components/admin/dealership-form";
import { Card, PageHeader } from "@/components/ui";

export const metadata: Metadata = { title: "Add dealership" };

export default async function NewDealershipPage() {
  await requireAdmin();
  const settings = await getSettings();
  const regions = allRegions(env().CRAWLER_EXTRA_REGIONS).map(({ id, label }) => ({ id, label }));
  return (
    <>
      <PageHeader
        breadcrumb={
          <Link href="/admin/dealerships" className="hover:underline">
            Dealerships
          </Link>
        }
        title="Add dealership"
        description="The first SEO scan and news check start automatically after saving."
      />
      <Card className="max-w-3xl">
        <DealershipForm action={createDealershipAction} defaultInterval={settings.seoIntervalHours} regions={regions} defaultRegionLabel={regionLabel(env().DEFAULT_CRAWLER_REGION, regions)} />
      </Card>
    </>
  );
}
