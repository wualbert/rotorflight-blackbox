#include "Nomad/nomad.hpp"
#include <emscripten.h>
#include <sstream>
#include <vector>
#include <iomanip>
EM_JS(int, rf_nomad_evaluate, (int n, const double *x, int m, double *y), {
    const values = Module['evaluate'](Array.from(HEAPF64.subarray(x / 8, x / 8 + n)));
    if (values === false) return -1;
    if (values === null) return 0;
    if (!Array.isArray(values) || values.length !== m || !values.every(Number.isFinite)) return 0;
    HEAPF64.set(values, y / 8);
    return 1;
});
static std::string message;
class FlightEvaluator : public NOMAD::Evaluator {
    int count;
public:
    FlightEvaluator(const std::shared_ptr<NOMAD::EvalParameters>& p, int m):NOMAD::Evaluator(p,NOMAD::EvalType::BB),count(m) {}
    bool eval_x(NOMAD::EvalPoint& x,const NOMAD::Double&,bool& countEval) const override {
        std::vector<double> in(x.size()),out(count);
        for(size_t i=0;i<x.size();++i)in[i]=x[i].todouble();
        int ok=rf_nomad_evaluate(in.size(),in.data(),count,out.data());countEval=ok>=0;
        if(ok<0){NOMAD::AllStopReasons::set(NOMAD::BaseStopType::USER_GLOBAL_STOP);return false;}
        if(!ok)return false;
        std::ostringstream s;s<<std::setprecision(17);
        for(double v:out)s<<v<<' ';
        x.setBBO(s.str());return true;
    }
};
extern "C" {
EMSCRIPTEN_KEEPALIVE const char* rf_nomad_message(){return message.c_str();}
EMSCRIPTEN_KEEPALIVE int rf_nomad_optimize(const char* input,int outputs){
    NOMAD::MainStep::resetComponentsBetweenOptimization();
    NOMAD::MainStep main;
    try {
        auto p=std::make_shared<NOMAD::AllParameters>();std::istringstream lines(input);std::string line;
        while(std::getline(lines,line))if(!line.empty())p->readParamLine(line);
        p->checkAndComply();main.setAllParameters(p);
        main.addEvaluator(std::make_unique<FlightEvaluator>(p->getEvalParams(),outputs));
        main.start();main.run();main.end();
        message=main.getAllStopReasons()->getStopReasonAsString();
        return main.getRunFlag();
    } catch(const std::exception& e){message=e.what();return -99;}
}
}
