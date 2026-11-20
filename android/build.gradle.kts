plugins {
    id("com.android.application") version "8.7.3" apply false
    id("org.jetbrains.kotlin.android") version "2.0.21" apply false
    id("org.jetbrains.kotlin.jvm") version "2.0.21" apply false
    id("org.jetbrains.kotlin.plugin.compose") version "2.0.21" apply false
}

gradle.projectsEvaluated {
    val engineProj = findProject(":engine") ?: return@projectsEvaluated
    val appProj = findProject(":app") ?: return@projectsEvaluated
    engineProj.tasks.named("milestone2Test") {
        mustRunAfter(
            appProj.tasks.matching { task ->
                val n = task.name
                n.startsWith("compile") ||
                    n.startsWith("lint") ||
                    n.startsWith("test") ||
                    n.startsWith("dex") ||
                    n.startsWith("minify")
            },
        )
    }
}
