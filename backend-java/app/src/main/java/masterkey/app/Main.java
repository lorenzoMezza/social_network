// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

package masterkey.app;

import java.util.List;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

/**
 * Starts the roles of this machine (JAVA-BACKEND.md §5). With {@code PRODUCTION=1} a
 * configuration that is not safe stops the start, saying why.
 */
public final class Main {

    private Main() {
    }

    @SpringBootApplication(scanBasePackages = {"masterkey.app", "masterkey.api"})
    static class Application {
    }

    public static void main(String[] args) {
        Settings settings = Settings.from(System.getenv(), args);
        if (settings.production()) {
            List<String> problems = settings.problems();
            if (!problems.isEmpty()) {
                System.err.println("Not safe for production:\n  - " + String.join("\n  - ", problems));
                System.exit(78);
            }
        }
        if (!settings.has(Settings.Role.API)) {
            // The machines of one role only (gateway, presence, worker) come with step 10 of §13
            System.err.println("ROLES without api are not available yet: start with ROLES=gateway,presence,api,worker");
            System.exit(78);
        }
        start(settings, args);
    }

    static org.springframework.context.ConfigurableApplicationContext start(Settings settings, String[] args) {
        SpringApplication application = new SpringApplication(Application.class);
        application.addInitializers(context -> context.getBeanFactory().registerSingleton("settings", settings));
        application.setDefaultProperties(java.util.Map.of("server.port", Integer.toString(settings.port())));
        return application.run(args);
    }
}
