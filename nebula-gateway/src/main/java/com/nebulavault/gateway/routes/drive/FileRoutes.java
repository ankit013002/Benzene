package com.nebulavault.gateway.routes.drive;

import com.nebulavault.gateway.filters.SessionToHeadersFilter;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.cloud.gateway.route.RouteLocator;
import org.springframework.cloud.gateway.route.builder.RouteLocatorBuilder;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;


@Configuration
public class FileRoutes {
    @Bean
    public RouteLocator customRouteLocator(RouteLocatorBuilder builder, @Value("${routes.files.uri}") String filesUri, SessionToHeadersFilter sessionFilter) {
        return builder.routes()
                .route("drive-write", r -> r
                        .path("/drive-nodes/**")
                        .filters(f -> f
                                .filter(sessionFilter)
                                .addResponseHeader("Nebula-Gateway", "Nebula Vault"))
                        .uri(filesUri)
                )
                .route("files-read", r -> r
                        .path("/files/**", "/folders/**")
                        .filters(f -> f
                                .filter(sessionFilter)
                                .addResponseHeader("Nebula-Gateway", "Nebula Vault"))
                        .uri(filesUri)
                )
                // Vault and device management are user-facing, so they carry
                // the same session verification as the file routes.
                .route("vault-and-devices", r -> r
                        .path("/vaults/**", "/devices/**")
                        .filters(f -> f
                                .filter(sessionFilter)
                                .addResponseHeader("Nebula-Gateway", "Benzene"))
                        .uri(filesUri)
                )
                // Placement decisions are user-scoped. The control plane
                // trusts identity headers only when this filter has verified
                // the session cookie at the gateway boundary.
                .route("placement", r -> r
                        .path("/placement/**")
                        .filters(f -> f
                                .filter(sessionFilter)
                                .addResponseHeader("Nebula-Gateway", "Benzene"))
                        .uri(filesUri)
                )
                // The node agent API deliberately skips the session filter: a
                // machine mid-enrollment holds no session, and an enrolled one
                // authenticates by Ed25519 request signature instead, which the
                // control plane verifies itself. Applying the session filter
                // here would make device enrollment impossible.
                .route("node-agent", r -> r
                        .path("/agent/**")
                        .filters(f -> f
                                .addResponseHeader("Nebula-Gateway", "Benzene"))
                        .uri(filesUri)
                )
                .build();
    }
}
