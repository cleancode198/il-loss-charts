import './banana-help.scss';
import { Box } from '@material-ui/core';

import pngBanana from './banana.png';
import pngClose from './close.png';
import pngMonkey from './monkey.png';

export const BananaHelp = (): JSX.Element => {
    const closeClick = () => {
        console.log('Click');
        const x = document.getElementById('bananaDiv');
        if (x.style.display === 'none') {
            x.style.display = 'block';
        } else {
            x.style.display = 'none';
        }
    };

    return (
        <div id='bananaDiv'>
            <Box
                display='flex'
                flexDirection='column'
                alignItems='center'
                justifyContent='space-around'
                className='main-content-container'
            >
                <Box className='banana-help-container'>
                    <Box
                        display='flex'
                        flexDirection='row'
                        justifyContent='space-around'
                        margin='20px'
                    >
                        <div className='banana-help-title'>
                            How Do You Get Bananas?
                        </div>
                        <div className='banana-help-close'>
                            <img
                                src={pngClose}
                                height={'29px'}
                                width={'29px'}
                                onClick={() => closeClick()}
                            />
                        </div>
                    </Box>

                    <Box
                        display='flex'
                        flexDirection='row'
                        justifyContent='space-around'
                        margin='20px'
                    >
                        <div className='banana-large-icon'>
                            <img src={pngMonkey} width={'98px'} />
                        </div>
                        <div className='banana-help-instructions'>
                            You are an ape! To begin collecting juicy bananas
                            you must deposit your tokens into the pools. You get
                            one pool to start.
                            <br />
                            <br />
                            You also need to choose a sentiment. To start adding
                            sentiment,you will have neutral sentiment as
                            default. Finish more levels and get access to more
                            features and sentiments!
                        </div>
                    </Box>
                </Box>
            </Box>
            <br />
        </div>
    );
};

export default BananaHelp;
//.add-v3-container .navigator-title-main
