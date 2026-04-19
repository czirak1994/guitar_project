#include <JuceHeader.h>
#include "MainComponent.h"

// ============================================================
//  JUCEApplicationBase  —  Application entry point
// ============================================================
class ToneCoachApplication : public juce::JUCEApplication
{
public:
    const juce::String getApplicationName() override    { return "ToneCoach"; }
    const juce::String getApplicationVersion() override { return "1.0.0"; }
    bool moreThanOneInstanceAllowed() override           { return false; }

    // ----------------------------------------------------------
    //  initialise  —  called after JUCE is ready
    // ----------------------------------------------------------
    void initialise (const juce::String& /*commandLine*/) override
    {
        mainWindow_ = std::make_unique<MainWindow> (getApplicationName());
    }

    void shutdown() override
    {
        mainWindow_.reset();
    }

    void systemRequestedQuit() override
    {
        quit();
    }

    void anotherInstanceStarted (const juce::String&) override {}

    // ----------------------------------------------------------
    //  DocumentWindow  —  minimal host window for AudioAppComponent
    // ----------------------------------------------------------
    class MainWindow : public juce::DocumentWindow
    {
    public:
        explicit MainWindow (const juce::String& name)
            : juce::DocumentWindow (name,
                                    juce::Colours::black,
                                    juce::DocumentWindow::allButtons)
        {
            setUsingNativeTitleBar (true);
            setContentOwned (new MainComponent(), true);

            setResizable (false, false);
            centreWithSize (getWidth(), getHeight());
            setVisible (true);
        }

        void closeButtonPressed() override
        {
            juce::JUCEApplication::getInstance()->systemRequestedQuit();
        }

    private:
        JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (MainWindow)
    };

private:
    std::unique_ptr<MainWindow> mainWindow_;
};

// ============================================================
//  JUCE_CREATE_APPLICATION macro — generates platform main()
// ============================================================
START_JUCE_APPLICATION (ToneCoachApplication)
