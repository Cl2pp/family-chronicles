ALTER TABLE "book_orders" ADD COLUMN "shipping_address" jsonb;--> statement-breakpoint
ALTER TABLE "book_orders" ADD COLUMN "print_file_s3_key" text;--> statement-breakpoint
ALTER TABLE "book_orders" ADD COLUMN "gelato_order_id" text;--> statement-breakpoint
ALTER TABLE "book_orders" ADD COLUMN "gelato_status" text;--> statement-breakpoint
ALTER TABLE "book_orders" ADD COLUMN "tracking_code" text;--> statement-breakpoint
ALTER TABLE "book_orders" ADD COLUMN "tracking_url" text;--> statement-breakpoint
ALTER TABLE "book_orders" ADD COLUMN "error_message" text;--> statement-breakpoint
ALTER TABLE "book_orders" ADD COLUMN "submitted_at" timestamp;--> statement-breakpoint
ALTER TABLE "book_orders" ADD COLUMN "shipped_at" timestamp;--> statement-breakpoint
ALTER TABLE "book_orders" ADD COLUMN "delivered_at" timestamp;--> statement-breakpoint
ALTER TABLE "book_orders" ADD COLUMN "status_checked_at" timestamp;--> statement-breakpoint
ALTER TABLE "book_orders" ADD COLUMN "updated_at" timestamp DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "books" ADD COLUMN "gelato_s3_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX "book_orders_gelato_order_uq" ON "book_orders" USING btree ("gelato_order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "book_orders_open_uq" ON "book_orders" USING btree ("book_id") WHERE status <> 'cancelled';