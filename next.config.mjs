/** @type {import('next').NextConfig} */
const nextConfig = {
	serverExternalPackages: ["better-sqlite3"],
	outputFileTracingExcludes: {
		"/*": ["./data/**/*", "./sessions/**/*", "./tests/**/*", "./.git/**/*"],
	},
};

export default nextConfig;
