// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

package masterkey.app;

import java.net.URI;
import java.time.Instant;
import java.time.InstantSource;
import masterkey.api.Limits;
import masterkey.api.Urls;
import masterkey.api.people.Accounts;
import masterkey.api.web.Etags;
import masterkey.api.web.Guard;
import masterkey.api.web.ViewerResolver;
import masterkey.auth.AppVersion;
import masterkey.auth.AuthConfig;
import masterkey.auth.Claims;
import masterkey.auth.TokenVerifier;
import masterkey.bus.Bus;
import masterkey.bus.LocalBus;
import masterkey.core.Json;
import masterkey.gateway.Authenticator;
import masterkey.gateway.Gateway;
import masterkey.gateway.GatewayConfig;
import masterkey.gateway.Sockets;
import masterkey.presence.PresenceClock;
import masterkey.presence.PresenceConfig;
import masterkey.presence.PresenceService;
import masterkey.store.Database;
import org.eclipse.jetty.server.Handler;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.jetty.JettyServerCustomizer;
import org.springframework.boot.web.servlet.FilterRegistrationBean;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import tools.jackson.databind.json.JsonMapper;

/**
 * Everything the roles need, made once: one clock, one database, one bus, the presence and the
 * gateway on the same port as the REST (§5). On one machine every role is here.
 */
@Configuration(proxyBeanMethods = false)
class AppConfig {

    private static final Logger log = LoggerFactory.getLogger(AppConfig.class);

    private final Settings settings;

    AppConfig(Settings settings) {
        this.settings = settings;
    }

    @Bean
    InstantSource clock() {
        return InstantSource.system();
    }

    /** The one JSON mapper (§16): Spring's converters, the gateway and the presence all use it. */
    @Bean
    JsonMapper jsonMapper() {
        return Json.MAPPER;
    }

    @Bean(destroyMethod = "close")
    Database database() {
        return Database.open(settings.databaseUrl(), settings.databaseUser(), settings.databasePassword(), settings.databasePool());
    }

    @Bean
    Bus bus() {
        return new LocalBus();
    }

    @Bean
    Urls urls() {
        return new Urls(settings.publicUrl(), settings.mediaUrl());
    }

    @Bean
    Limits limits() {
        return new Limits();
    }

    @Bean
    ErasedAccounts erasedAccounts(Database db) {
        return new ErasedAccounts(db);
    }

    @Bean
    TokenVerifier tokenVerifier(InstantSource clock, ErasedAccounts erased) {
        AuthConfig logto = AuthConfig.logto(settings.logtoIssuer(), settings.apiResource(), settings.logtoAppId());
        AuthConfig config = new AuthConfig(logto.issuer(),
                settings.logtoJwks() != null ? URI.create(settings.logtoJwks()) : logto.jwks(),
                settings.logtoUserinfo() != null ? URI.create(settings.logtoUserinfo()) : logto.userinfo(),
                settings.apiResource(), settings.logtoAppId(), settings.trustUnverifiedTokens(), settings.production());
        return new TokenVerifier(config, clock, erased);
    }

    @Bean
    Accounts accounts(Database db, TokenVerifier tokens, InstantSource clock) {
        return new Accounts(db, tokens, clock);
    }

    @Bean(destroyMethod = "close")
    Sockets sockets() {
        return new Sockets(Math.max(2, Runtime.getRuntime().availableProcessors() / 2));
    }

    @Bean(destroyMethod = "close")
    DbDirectory directory(Database db, Urls urls) {
        return new DbDirectory(db, urls);
    }

    @Bean(destroyMethod = "close")
    PresenceService presence(DbDirectory directory, Sockets sockets) {
        PresenceConfig config = PresenceConfig.of(settings.areaKey(), settings.maxTravelSpeed()).withMaxShown(settings.maxShown());
        PresenceService presence = new PresenceService(config, directory, sockets, PresenceClock.system(), () -> {
            // The round stopped: the process goes, and is started again (or the standby takes over)
            log.error("presence stalled: exiting");
            Runtime.getRuntime().halt(70);
        });
        presence.start();
        return presence;
    }

    @Bean
    Authenticator authenticator(TokenVerifier tokens, Accounts accounts, InstantSource clock) {
        return token -> {
            Claims claims = tokens.verify(token);
            var viewer = accounts.viewer(claims, null, null);
            // An opaque token (development) has no exp of its own: an hour, as the Python
            Instant expires = claims.issued().equals(Instant.EPOCH) ? clock.instant().plusSeconds(3600) : claims.expires();
            return new Authenticator.Identity(viewer.id(), expires);
        };
    }

    @Bean(destroyMethod = "close")
    Gateway gateway(Sockets sockets, PresenceService presence, Authenticator authenticator, Bus bus, InstantSource clock) {
        return new Gateway(GatewayConfig.defaults(1), sockets, presence, authenticator, bus, clock);
    }

    /** /v1/ws in front of Spring on the same port, and Jetty's own errors as JSON. */
    @Bean
    JettyServerCustomizer websockets(Gateway gateway) {
        return server -> {
            server.setErrorHandler(new JsonErrorHandler());
            Handler rest = server.getHandler();
            server.setHandler(gateway.wrap(server, rest));
        };
    }

    // --- the areas of the REST ---

    @Bean
    masterkey.api.common.Outbox outbox(Bus bus) {
        return new masterkey.api.common.Outbox(bus);
    }

    @Bean
    masterkey.api.common.People people(Urls urls) {
        return new masterkey.api.common.People(urls);
    }

    @Bean
    masterkey.api.common.Relations relations(PresenceService presence) {
        return new masterkey.api.common.Relations(presence);
    }

    @Bean
    masterkey.api.events.EventViews eventViews(masterkey.api.common.People people, Urls urls) {
        return new masterkey.api.events.EventViews(people, urls);
    }

    @Bean(destroyMethod = "close")
    masterkey.api.events.EventNotifier eventNotifier(Database db, PresenceService presence, masterkey.api.events.EventViews views,
                                                     masterkey.api.common.Outbox outbox, InstantSource clock) {
        return new masterkey.api.events.EventNotifier(db, presence, views, outbox, clock);
    }

    @Bean
    masterkey.api.notifications.Notifications notifications(masterkey.api.common.People people, masterkey.api.events.EventViews views,
                                                            masterkey.api.common.Outbox outbox, InstantSource clock, DbDirectory directory,
                                                            Database db, masterkey.api.common.Later later) {
        var notifications = new masterkey.api.notifications.Notifications(people, views, outbox, later, clock);
        // A "Connect" invitation from the presence is also one of the invited person's notifications
        directory.onInvited((target, actor) -> db.txRun(ctx -> notifications.notify(ctx, target, "connect.invite", actor, null, null)));
        return notifications;
    }

    @Bean
    masterkey.api.chats.Chats chats(masterkey.api.common.People people, masterkey.api.common.Relations relations,
                                    masterkey.api.common.Outbox outbox, Urls urls, masterkey.api.common.Later later, InstantSource clock) {
        return new masterkey.api.chats.Chats(people, relations, outbox, urls, later, clock);
    }

    @Bean
    masterkey.api.people.ConnectSessions connectSessions(InstantSource clock) {
        return new masterkey.api.people.ConnectSessions(clock);
    }

    // --- avatars ---

    @Bean
    masterkey.api.avatars.AvatarLibrary avatarLibrary() {
        return new masterkey.api.avatars.AvatarLibrary(java.nio.file.Path.of(settings.avatarLibrary()));
    }

    @Bean(destroyMethod = "close")
    masterkey.api.avatars.MapAvatars mapAvatars() {
        return new masterkey.api.avatars.MapAvatars(settings.avatarBakerUrl(), settings.avatarBakeSecret(),
                java.time.Duration.ofSeconds(settings.avatarBakeTimeoutSeconds()));
    }

    // --- files ---

    @Bean
    masterkey.api.media.Storage storage(Urls urls, InstantSource clock) {
        Settings.R2 r2 = settings.r2();
        if (r2.set() && r2.endpoint() != null && r2.accessKeyId() != null && r2.secretAccessKey() != null && r2.originalsBucket() != null
                && r2.publicBucket() != null) {
            masterkey.api.media.CdnPurge purge = r2.purgeZone() != null && r2.purgeToken() != null
                    ? new masterkey.api.media.CdnPurge(r2.purgeZone(), r2.purgeToken()) : null;
            return new masterkey.api.media.R2Storage(r2.endpoint(), r2.accessKeyId(), r2.secretAccessKey(), r2.originalsBucket(),
                    r2.publicBucket(), urls, purge, clock);
        }
        // Development: a folder of this machine, served by the API itself
        return new masterkey.api.media.LocalStorage(java.nio.file.Path.of(settings.dataDir()), urls, clock);
    }

    @Bean
    masterkey.api.media.Imaging imaging(masterkey.api.media.Storage storage) {
        if (settings.imagedUrl() != null && settings.imagedSecret() != null) {
            return new masterkey.api.media.ImagedClient(java.net.URI.create(settings.imagedUrl()), settings.imagedSecret());
        }
        // Development only: Settings.problems() stops a production start without imaged
        if (!(storage instanceof masterkey.api.media.LocalStorage local)) {
            throw new IllegalStateException("R2 needs imaged: set IMAGED_URL and IMAGED_SECRET");
        }
        return new masterkey.api.media.DevImaging(local);
    }

    @Bean
    masterkey.api.media.Uploads uploads(Database db, masterkey.api.media.Storage storage, masterkey.api.media.Imaging imaging,
                                        masterkey.api.common.Later later, InstantSource clock) {
        return new masterkey.api.media.Uploads(db, storage, imaging, later, clock);
    }

    // --- jobs (§6, §8): every machine writes them, the worker role runs them ---

    @Bean
    com.github.kagkarlsson.scheduler.SchedulerClient schedulerClient(Database db) {
        return masterkey.jobs.Jobs.client(db.dataSource());
    }

    @Bean
    masterkey.api.common.Later later(com.github.kagkarlsson.scheduler.SchedulerClient client, InstantSource clock) {
        return new masterkey.jobs.QueuedLater(client, clock);
    }

    @Bean
    masterkey.jobs.Work work(Database db, masterkey.api.media.Storage storage, masterkey.api.media.Uploads uploads, Limits limits,
                             masterkey.api.notifications.Notifications notifications, masterkey.api.common.Outbox outbox,
                             masterkey.api.events.EventNotifier notifier, masterkey.api.common.Later later, InstantSource clock) {
        masterkey.auth.LogtoAdmin logto = settings.logtoM2mAppId() == null || settings.logtoM2mAppSecret() == null ? null
                : new masterkey.auth.LogtoAdmin(settings.logtoIssuer(), settings.logtoManagementResource(), settings.logtoM2mAppId(),
                        settings.logtoM2mAppSecret(), clock);
        return new masterkey.jobs.Work(db, storage, uploads, limits, notifications, outbox, notifier, later, logto, clock);
    }

    // --- the user's rights ---

    @Bean
    masterkey.api.privacy.Erasure erasure(Database db, masterkey.api.chats.Chats chats, masterkey.api.notifications.Notifications notifications,
                                          masterkey.api.events.EventNotifier notifier, masterkey.api.common.Outbox outbox,
                                          masterkey.api.common.Later later, PresenceService presence, Limits limits,
                                          masterkey.api.people.ConnectSessions sessions, TokenVerifier tokens, ErasedAccounts erased,
                                          InstantSource clock) {
        return new masterkey.api.privacy.Erasure(db, chats, notifications, notifier, outbox, later, presence, limits, sessions, tokens,
                erased::erased, clock);
    }

    @Bean
    masterkey.api.privacy.Export export(Database db, Urls urls, InstantSource clock) {
        return new masterkey.api.privacy.Export(db, urls, clock);
    }

    /** Pushes straight to APNs and FCM (§14, D5), each only when configured. */
    @Bean
    masterkey.jobs.push.Pushes pushes(Database db, PresenceService presence, InstantSource clock) {
        Settings.Push push = settings.push();
        masterkey.jobs.push.PushSender apns = null;
        if (push.apnsKeyFile() != null && push.apnsKeyId() != null && push.apnsTeamId() != null && push.apnsTopic() != null) {
            apns = new masterkey.jobs.push.Apns(push.apnsSandbox() ? masterkey.jobs.push.Apns.SANDBOX : masterkey.jobs.push.Apns.PRODUCTION,
                    java.nio.file.Path.of(push.apnsKeyFile()), push.apnsKeyId(), push.apnsTeamId(), push.apnsTopic(), clock);
        }
        masterkey.jobs.push.PushSender fcm = push.fcmServiceAccountFile() == null ? null
                : masterkey.jobs.push.Fcm.of(java.nio.file.Path.of(push.fcmServiceAccountFile()));
        if (apns == null || fcm == null) log.warn("push: {} not set, its phones get no push", apns == null && fcm == null ? "APNs and FCM are" : apns == null ? "APNs is" : "FCM is");
        return new masterkey.jobs.push.Pushes(db, presence, apns, fcm);
    }

    @Bean
    JobsRunner jobsRunner(Database db, masterkey.jobs.Work work, masterkey.jobs.push.Pushes pushes) {
        return new JobsRunner(settings.has(Settings.Role.WORKER) ? masterkey.jobs.Jobs.worker(db.dataSource(), work, pushes, settings.jobThreads()) : null);
    }

    @Bean
    masterkey.api.events.Images images(Urls urls, masterkey.api.media.Uploads uploads) {
        return new masterkey.api.events.Images(urls, uploads);
    }

    // --- money ---

    /** The stores, each only when configured (else 503); test top-ups only with DEV_TOOLS. */
    @Bean
    masterkey.api.money.Stores stores() {
        Settings.Purchases purchases = settings.purchases();
        masterkey.api.money.AppleStore apple = null;
        if (purchases.appleBundleId() != null && purchases.appleAppId() != null && purchases.appleRootCa() != null) {
            java.util.List<java.nio.file.Path> roots = java.util.Arrays.stream(purchases.appleRootCa().split(",", -1))
                    .map(String::strip).filter(part -> !part.isEmpty()).map(java.nio.file.Path::of).toList();
            apple = new masterkey.api.money.AppleStore(purchases.appleBundleId(), purchases.appleAppId(), roots,
                    purchases.appleAllowSandbox(), purchases.appleOnlineChecks());
        }
        masterkey.api.money.GoogleStore google = null;
        if (purchases.googlePackageName() != null && purchases.googleServiceAccountFile() != null) {
            google = new masterkey.api.money.GoogleStore(purchases.googlePackageName(), java.nio.file.Path.of(purchases.googleServiceAccountFile()),
                    purchases.googleAllowTestPurchases(), purchases.googleRtdnSecret());
        }
        return new masterkey.api.money.Stores(apple, google, settings.devTools());
    }

    @Bean
    masterkey.api.money.Watchers watchers(masterkey.api.events.EventNotifier notifier) {
        return notifier::changed;
    }

    @Bean
    FilterRegistrationBean<Guard> guard() {
        FilterRegistrationBean<Guard> registration = new FilterRegistrationBean<>(new Guard(new AppVersion(settings.minAppVersion())));
        registration.setOrder(Integer.MIN_VALUE + 100);
        registration.addUrlPatterns("/*");
        return registration;
    }

    @Bean
    FilterRegistrationBean<Etags> etags() {
        FilterRegistrationBean<Etags> registration = new FilterRegistrationBean<>(new Etags());
        registration.setOrder(Integer.MIN_VALUE + 200);
        registration.addUrlPatterns("/*");
        return registration;
    }

    @Bean
    ViewerResolver viewerResolver(TokenVerifier tokens, Accounts accounts, Limits limits) {
        return new ViewerResolver(tokens, accounts, limits);
    }
}
